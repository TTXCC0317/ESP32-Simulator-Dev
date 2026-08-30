/**
 * ESP32Sim 引擎B HAL 桥 glue（M5 方案F，03-§7.2）
 *
 * 强符号覆盖 Arduino GPIO HAL（无 --wrap，无需编译命令注入）：
 *   pinMode / digitalWrite / digitalRead / attachInterrupt / attachInterruptArg /
 *   detachInterrupt —— core 3.x 中这些是 __pinMode 等真实实现的 weak alias
 *   （esp32-hal-gpio.c），链接器取 glue 的强定义覆盖，所有引用（含 core 内部）
 *   统一进桥后转发 __* 真实实现。
 *
 * 为什么不用 -Wl,--wrap：wrap 只重定向 undefined reference，而 digitalWrite 在
 * core.a 里有 weak 定义（alias），引用被就地满足不产生 undefined reference，
 * wrap 静默失效（M5 golden 实测踩坑，ELF 中 __wrap_* 被 gc-sections 丢弃）。
 *
 * 帧协议（5 字节定长，XOR 校验）：0xA5 | type | pin | value | xor(前4字节异或)
 *   0x01 GPIO_WRITE 固件→宿主（value=level）
 *   0x02 PIN_MODE   固件→宿主（value=Arduino mode，pullup/pulldown 位供 release 语义）
 *   0x11 GPIO_INPUT 宿主→固件（value=level，注入 + 沿匹配触发 attachInterrupt 回调）
 *
 * M5 限制：
 *   - ISR 上下文中的 digitalWrite 不上报（uart_write_bytes 非 ISR-safe，避免崩溃）；
 *   - 注入中断回调在 UART RX task 上下文调用（非 ISR），语义与 Wokwi 一致；
 *   - 仅覆盖 Arduino HAL（digitalWrite/attachInterrupt），直调 ESP-IDF gpio_set_level 不可见。
 *
 * 由 BuildService 在编译时写入 sketch 目录，随固件一起编译（无 core 污染）。
 */

#include <stdint.h>
#include <stddef.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/uart.h"
#include "soc/soc_caps.h"
#include "soc/gpio_num.h"
#include "esp32-hal.h"

/* ---- 真实 HAL（core 3.x esp32-hal-gpio.c 强符号，直接转发） ---- */

extern void __pinMode(uint8_t pin, uint8_t mode);
extern void __digitalWrite(uint8_t pin, uint8_t val);
extern int __digitalRead(uint8_t pin);
extern void __attachInterrupt(uint8_t pin, void (*userFunc)(void), int intr_type);
extern void __attachInterruptArg(uint8_t pin, void (*userFunc)(void *), void *arg, int intr_type);
extern void __detachInterrupt(uint8_t pin);

/* ---- 桥状态 ---- */

#define BR_UART      UART_NUM_1
#define BR_BAUD      115200
#define BR_TXD       19 /* QEMU 忽略引脚 mux；真机 remap 到安全引脚避免 flash 冲突 */
#define BR_RXD       18
#define BR_RX_TASK_STACK  3072

#define FR_MAGIC  0xA5u
#define FR_SIZE   5
#define FR_GPIO_WRITE 0x01u
#define FR_PIN_MODE   0x02u
#define FR_GPIO_INPUT 0x11u

/* 输入注入表：-1 无注入（读真实引脚），0/1 注入电平 */
static volatile int8_t s_inject[SOC_GPIO_PIN_COUNT];

/* attachInterrupt 记录：注入沿匹配时由 RX task 调用 */
typedef struct {
  void (*fn)(void *);
  void *arg;
  int intr_type;     /* gpio_int_type_t：1=POSEDGE 2=NEGEDGE 3=ANYEDGE */
  int8_t last_level; /* -1 未知（首次注入不触发） */
} br_irq_t;

static volatile br_irq_t s_irq[SOC_GPIO_PIN_COUNT];

static volatile bool s_ready = false;

/* ---- 帧收发 ---- */

static void br_send_frame(uint8_t type, uint8_t pin, uint8_t value) {
  const uint8_t fr[FR_SIZE] = { FR_MAGIC, type, pin, value,
                                (uint8_t)(FR_MAGIC ^ type ^ pin ^ value) };
  (void)uart_write_bytes(BR_UART, (const char *)fr, FR_SIZE);
}

/* 输出上报入口（task 上下文；ISR 内静默跳过，见头注释 M5 限制） */
static void br_report(uint8_t type, uint8_t pin, uint8_t value) {
  if (!s_ready) return;
  if (xPortInIsrContext() != pdFALSE) return;
  br_send_frame(type, pin, value);
}

/* ---- 惰性初始化（首个 GPIO HAL 调用时；幂等） ---- */

static void br_rx_task(void *arg);

static void br_init(void) {
  if (s_ready) return;

  uart_config_t cfg = {
    .baud_rate = BR_BAUD,
    .data_bits = UART_DATA_8_BITS,
    .parity = UART_PARITY_DISABLE,
    .stop_bits = UART_STOP_BITS_1,
    .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
    .source_clk = UART_SCLK_DEFAULT,
  };
  if (uart_param_config(BR_UART, &cfg) != ESP_OK) return;
  if (uart_set_pin(BR_UART, BR_TXD, BR_RXD, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) {
    return;
  }
  if (uart_driver_install(BR_UART, 256, 0, 0, NULL, 0) != ESP_OK) return;

  if (xTaskCreate(br_rx_task, "br_rx", BR_RX_TASK_STACK, NULL,
                  tskIDLE_PRIORITY + 2, NULL) != pdPASS) {
    uart_driver_delete(BR_UART);
    return;
  }
  s_ready = true;
}

/* ---- RX：帧状态机 → 注入 + 中断触发 ---- */

static void br_apply_input(uint8_t pin, uint8_t level) {
  if (pin >= SOC_GPIO_PIN_COUNT) return;

  const int8_t lv = level ? 1 : 0;

  const br_irq_t irq = s_irq[pin];
  if (irq.fn != NULL && irq.last_level >= 0 && irq.last_level != lv) {
    const bool rising = (lv == 1);
    bool hit = (irq.intr_type == 3); /* ANYEDGE */
    if (!hit) hit = rising ? (irq.intr_type == 1) : (irq.intr_type == 2);
    if (hit) irq.fn(irq.arg); /* RX task 上下文（Wokwi 同语义） */
  }
  if (irq.last_level != lv) s_irq[pin].last_level = lv;
  s_inject[pin] = lv;
}

static void br_rx_task(void *arg) {
  (void)arg;
  uint8_t buf[64];
  uint8_t fr[4];
  size_t got = 0;

  for (;;) {
    const int n = uart_read_bytes(BR_UART, buf, sizeof(buf), pdMS_TO_TICKS(50));
    for (int i = 0; i < n; i++) {
      const uint8_t b = buf[i];
      if (got == 0) {
        if (b != FR_MAGIC) continue; /* 重同步 */
        got = 1;
      } else {
        fr[got - 1] = b;
        got += 1;
        if (got < FR_SIZE) continue;

        got = 0;
        const uint8_t chk = (uint8_t)(FR_MAGIC ^ fr[0] ^ fr[1] ^ fr[2]);
        if (chk != fr[3]) continue; /* 坏帧丢弃 */
        if (fr[0] == FR_GPIO_INPUT) br_apply_input(fr[1], fr[2]);
      }
    }
  }
}

/* ---- HAL 强定义（覆盖 core 的 weak alias，统一进桥） ---- */

void pinMode(uint8_t pin, uint8_t mode) {
  __pinMode(pin, mode);
  br_init();
  br_report(FR_PIN_MODE, pin, mode);
}

void digitalWrite(uint8_t pin, uint8_t val) {
  __digitalWrite(pin, val);
  br_init();
  br_report(FR_GPIO_WRITE, pin, val ? 1 : 0);
}

int digitalRead(uint8_t pin) {
  br_init();
  if (pin < SOC_GPIO_PIN_COUNT && s_inject[pin] >= 0) return s_inject[pin];
  return __digitalRead(pin);
}

void br_record_irq(uint8_t pin, void (*fn)(void *), void *arg, int intr_type) {
  br_init();
  if (pin < SOC_GPIO_PIN_COUNT) {
    s_irq[pin].fn = fn;
    s_irq[pin].arg = arg;
    s_irq[pin].intr_type = intr_type;
    s_irq[pin].last_level = -1;
  }
}

void attachInterrupt(uint8_t pin, void (*userFunc)(void), int intr_type) {
  __attachInterrupt(pin, userFunc, intr_type);
  br_record_irq(pin, (void (*)(void *))userFunc, NULL, intr_type);
}

void attachInterruptArg(uint8_t pin, void (*userFunc)(void *), void *arg, int intr_type) {
  __attachInterruptArg(pin, userFunc, arg, intr_type);
  br_record_irq(pin, userFunc, arg, intr_type);
}

void detachInterrupt(uint8_t pin) {
  __detachInterrupt(pin);
  if (pin < SOC_GPIO_PIN_COUNT) {
    s_irq[pin].fn = NULL;
    s_irq[pin].arg = NULL;
    s_irq[pin].last_level = -1;
  }
}
