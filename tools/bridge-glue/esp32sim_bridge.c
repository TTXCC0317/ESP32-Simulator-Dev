/**
 * ESP32Sim 引擎B HAL 桥 glue（M7/M8 方案，03-§7.2.2）
 *
 * 强符号覆盖 Arduino GPIO HAL（无 --wrap，无需编译命令注入）：
 *   pinMode / digitalWrite / digitalRead / attachInterrupt / attachInterruptArg /
 *   detachInterrupt / analogWrite / analogWriteFrequency / analogRead
 *   —— core 3.x 中这些是 __pinMode 等真实实现的 weak alias
 *   （esp32-hal-gpio.c / esp32-hal-ledc.c），链接器取 glue 的强定义覆盖，
 *   所有引用（含 core 内部）统一进桥后转发 __* 真实实现。
 *
 * 为什么不用 -Wl,--wrap：wrap 只重定向 undefined reference，而 digitalWrite 在
 * core.a 里有 weak 定义（alias），引用被就地满足不产生 undefined reference，
 * wrap 静默失效（M5 golden 实测踩坑，ELF 中 __wrap_* 被 gc-sections 丢弃）。
 *
 * 帧协议：
 *   定长帧（type < 0x20，M5–M7）：A5 | type | pin | vH | vL | xor(前5字节异或) —— 6 字节
 *     0x01 GPIO_WRITE 固件→宿主（vH=0, vL=0/1，数字写 level）
 *     0x02 PIN_MODE   固件→宿主（vH=0, vL=Arduino mode，pullup/pulldown 位供 release 语义）
 *     0x03 PWM_WRITE  固件→宿主（vH:vL = duty 0–1023，LEDC 10 位归一化）
 *     0x04 PWM_FREQ   固件→宿主（vH:vL = freq Hz，0–65535）
 *     0x11 GPIO_INPUT 宿主→固件（vH=0, vL=0/1，注入 + 沿匹配触发 attachInterrupt 回调）
 *     0x12 ADC_INPUT  宿主→固件（vH:vL = 0–4095，钳位 12 位，analogRead 注入值）
 *   TLV 变长帧（type ≥ 0x20，M8 I2C/SPI 事务）：A5 | type | len | payload | xor(前 len+3 字节异或)
 *     0x20 I2C_TXN    固件→宿主（payload: addr | dir | wlen | wdata[wlen]）
 *     0x21 SPI_TXN    固件→宿主（payload: cs | wlen | wdata[wlen]）
 *     0x30 SENSOR_REPLY 宿主→固件（payload: addr | data[]，I2C 读应答）
 *     0x31 SPI_REPLY    宿主→固件（payload: cs | data[]，SPI 应答）
 *
 * PWM duty 归一化：analogWrite(0–255, 8 位) 左移 2 位 → 0–1020（10 位域），
 * 与 WS 协议 / glue 上报统一 0–1023。
 *
 * M8 回复机制（br_i2c_txn / br_spi_txn）：
 *   - bus_shim.cpp 调用后发送 TLV 帧并阻塞在二值信号量上，50ms 超时防死锁；
 *   - RX task 收到 SENSOR_REPLY/SPI_REPLY 时复制 data 到 s_reply_buf 并 give 信号量；
 *   - 单槽语义：bridge 单 UART 通道，shim 必须串行调用（TwoWire/SPIClass 默认即串行）。
 *
 * M5/M7/M8 限制：
 *   - ISR 上下文中的 digitalWrite/I2C/SPI 事务不上报（uart_write_bytes 非 ISR-safe，
 *     且信号量不可在 ISR 内 take/give；ISR 内调用直接返回 0）；
 *   - 注入中断回调在 UART RX task 上下文调用（非 ISR），语义与 Wokwi 一致；
 *   - 仅覆盖 Arduino HAL（digitalWrite/attachInterrupt/analogWrite/TwoWire/SPIClass 等），
 *     直调 ESP-IDF gpio_set_level / ledc_set_duty / i2c_* / spi_* 不可见。
 *
 * 由 BuildService 在编译时写入 sketch 目录，随固件一起编译（无 core 污染）。
 */

#include <stdint.h>
#include <stddef.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "driver/uart.h"
#include "soc/soc_caps.h"
#include "soc/gpio_num.h"
#include "esp32-hal.h"
#include "esp32-hal-ledc.h"
#include "esp32-hal-periman.h"

#include "esp32sim_bridge.h"

/* ---- 真实 HAL（core 3.x 强符号，直接转发） ---- */

extern void __pinMode(uint8_t pin, uint8_t mode);
extern void __digitalWrite(uint8_t pin, uint8_t val);
extern int __digitalRead(uint8_t pin);
extern void __attachInterrupt(uint8_t pin, void (*userFunc)(void), int intr_type);
extern void __attachInterruptArg(uint8_t pin, void (*userFunc)(void *), void *arg, int intr_type);
extern void __detachInterrupt(uint8_t pin);
/* analogWrite / analogWriteFrequency / analogRead（M7 PWM + ADC glue）
 *
 * ⚠️ esp32 core 3.3.10 的 esp32-hal-ledc.c 直接定义了 analogWrite / analogWriteFrequency
 * （无 weak alias、不暴露 __analogWrite / __analogWriteFrequency 强符号）——不能转调。
 * 替代方案：glue 用 ESP-IDF ledc*（Attach / ChangeFrequency / Write / WriteNote）自行
 * 实现相同语义（8bit 分辨率、默认 1kHz），同时保证桥 PWM_WRITE/PWM_FREQ 帧上报；
 * 签名仍然对齐公共头（void analogWrite(uint8_t,int) / void analogWriteFrequency(uint8_t,uint32_t)），
 * 仍然由 glue 的强定义覆盖 core.a 中同名符号（同名定义冲突的解决：core.a 里同名对象
 * 是"未被引用的 weak alias target"，但 core 3.3.10 里 analogWrite 实际上是普通
 * 强定义 → 此版本 glue 不再调用核心实现，由桥直接提供完整实现以避免链接器 multiple
 * definition，核心实现的代码路径不再生效，桥通过 ESP-IDF ledc API 直接驱动外设。
 *
 * ⚠️ analogRead 虽然核心有 weak alias → __analogRead 可转调，但 QEMU Espressif fork
 * 不模拟 ADC 外设，转调会进入 adc_oneshot_ll_get_event 等待不存在的 ADC 完成事件 →
 * Cache error panic。因此 glue 短路：有注入返回注入值，无注入返回 0（05-§1.6 E3），
 * 永不转调 __analogRead。extern 声明已移除。 */


/* ---- 桥状态 ---- */

#define BR_UART      UART_NUM_1
#define BR_BAUD      115200
#define BR_TXD       19 /* QEMU 忽略引脚 mux；真机 remap 到安全引脚避免 flash 冲突 */
#define BR_RXD       18
#define BR_RX_TASK_STACK  3072

#define FR_MAGIC    0xA5u
#define FR_SIZE     6
#define FR_GPIO_WRITE  0x01u
#define FR_PIN_MODE    0x02u
#define FR_PWM_WRITE   0x03u
#define FR_PWM_FREQ    0x04u
#define FR_GPIO_INPUT  0x11u
#define FR_ADC_INPUT   0x12u

/* M8 TLV 变长帧类型（type ≥ 此阈值走变长解析） */
#define FR_TLV_THRESHOLD  0x20u
#define FR_I2C_TXN      0x20u
#define FR_SPI_TXN      0x21u
/* M8 后续：DHT22 单总线请求 */
#define FR_DHT22_TXN    0x22u
#define FR_SENSOR_REPLY 0x30u
#define FR_SPI_REPLY    0x31u
/* M8 后续：DHT22 回复 */
#define FR_DHT22_REPLY  0x32u

/* M8 回复等待槽：单 UART 通道，shim 必须串行调用 */
#define BR_REPLY_TIMEOUT_MS 50u
#define BR_REPLY_MAX        255u

static SemaphoreHandle_t s_reply_sem = NULL;
static uint8_t s_reply_buf[BR_REPLY_MAX];
static volatile size_t s_reply_len = 0;

#define DEFAULT_PWM_FREQ 1000u

/* 输入注入表：-1 无注入（读真实引脚），0/1 注入电平 */
static volatile int8_t s_inject[SOC_GPIO_PIN_COUNT];

/* ADC 注入表：-1 无注入（读真实 ADC），0–4095 注入值（12 位） */
static volatile int16_t s_analog_inject[SOC_GPIO_PIN_COUNT];

/* 固件 pull 声明表（pinMode INPUT_PULLUP/DOWN 时记录）：QEMU 不模拟上/下拉，
 * 悬空输入经 __digitalRead 恒读 0（幻象按下）——无注入时按 pull 声明返回电平。
 * -1 无 pull 声明（OUTPUT/纯 INPUT），0/1 对应 pulldown/pullup 电平 */
static volatile int8_t s_pull[SOC_GPIO_PIN_COUNT];

/* PWM 频率跟踪：0 = 尚未发送过（首次 analogWrite 时补发 DEFAULT_PWM_FREQ 帧），
 * 否则为最近一次 analogWriteFrequency 设置的频率（Hz，uint16 域）。 */
static volatile uint16_t s_pwm_freq_sent[SOC_GPIO_PIN_COUNT];

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

static void br_send_frame(uint8_t type, uint8_t pin, uint16_t value16) {
  const uint8_t vH = (uint8_t)(value16 >> 8);
  const uint8_t vL = (uint8_t)(value16 & 0xFFu);
  const uint8_t fr[FR_SIZE] = { FR_MAGIC, type, pin, vH, vL,
                                (uint8_t)(FR_MAGIC ^ type ^ pin ^ vH ^ vL) };
  (void)uart_write_bytes(BR_UART, (const char *)fr, FR_SIZE);
}

/* M8 TLV 变长帧发送：A5 | type | len | payload | xor(前 len+3 字节) */
static void br_send_tlv(uint8_t type, const uint8_t *payload, uint8_t len) {
  uint8_t buf[3 + 255 + 1];
  buf[0] = FR_MAGIC;
  buf[1] = type;
  buf[2] = len;
  uint8_t xor = (uint8_t)(FR_MAGIC ^ type ^ len);
  for (uint8_t i = 0; i < len; i++) {
    buf[3 + i] = payload[i];
    xor ^= payload[i];
  }
  buf[3 + len] = xor;
  (void)uart_write_bytes(BR_UART, (const char *)buf, (size_t)(3 + len + 1));
}

/* 输出上报入口（task 上下文；ISR 内静默跳过，见头注释限制） */
static void br_report(uint8_t type, uint8_t pin, uint16_t value16) {
  if (!s_ready) return;
  if (xPortInIsrContext() != pdFALSE) return;
  br_send_frame(type, pin, value16);
}

/* ---- 惰性初始化（首个 GPIO HAL 调用时；幂等） ---- */

static void br_rx_task(void *arg);

static void br_init(void) {
  if (s_ready) return;

  /* s_inject / s_analog_inject / s_pull 静态零初始化会把"未注入"当成注入 0
   * （幻象按下，M6 golden 实测：button-led 首轮 digitalRead 恒 0）——
   * 按注释语义初始化为 -1（读真实硬件）；s_pwm_freq_sent 初始化为 0 表示未发过。 */
  for (int i = 0; i < SOC_GPIO_PIN_COUNT; i++) {
    s_inject[i] = -1;
    s_analog_inject[i] = -1;
    s_pull[i] = -1;
    s_pwm_freq_sent[i] = 0;
  }

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

  /* M8 回复信号量：二值，初始空（无回复） */
  if (s_reply_sem == NULL) {
    s_reply_sem = xSemaphoreCreateBinary();
    if (s_reply_sem == NULL) {
      uart_driver_delete(BR_UART);
      return;
    }
  }

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

static void br_rx_task(void *arg);

/* M8 TLV 回复处理：复制 data 到 s_reply_buf 并 give 信号量 */
static void br_handle_reply(uint8_t type, const uint8_t *payload, uint8_t len) {
  if (type != FR_SENSOR_REPLY && type != FR_SPI_REPLY && type != FR_DHT22_REPLY) return;
  /* SENSOR_REPLY: addr | data[] ；SPI_REPLY: cs | data[] ；DHT22_REPLY: pin | tempRaw_hi | tempRaw_lo | humRaw_hi | humRaw_lo
   * 共同格式：第 1 字节为 addr/cs/pin，剩余为 data */
  if (len == 0) {
    s_reply_len = 0;
  } else {
    size_t copy = len - 1;
    if (copy > BR_REPLY_MAX) copy = BR_REPLY_MAX;
    for (size_t i = 0; i < copy; i++) s_reply_buf[i] = payload[i + 1];
    s_reply_len = copy;
  }
  if (s_reply_sem != NULL) {
    (void)xSemaphoreGive(s_reply_sem);
  }
}

/* RX 状态机相位 */
typedef enum {
  RX_MAGIC,        /* 等待 A5 */
  RX_TYPE,         /* 读 type 字节，决定定长/变长 */
  RX_FIXED,        /* 定长帧：收集 [pin, vH, vL, chk] 4 字节 */
  RX_TLV_LEN,      /* TLV 帧：读 len */
  RX_TLV_PAYLOAD   /* TLV 帧：收集 payload + chk = len+1 字节 */
} rx_phase_t;

static void br_rx_task(void *arg) {
  (void)arg;
  uint8_t buf[64];
  rx_phase_t phase = RX_MAGIC;

  /* 定长帧状态：fr[0]=type, fr[1]=pin, fr[2]=vH, fr[3]=vL, fr[4]=chk */
  uint8_t fr[5];
  size_t fr_idx = 0;

  /* TLV 帧状态 */
  uint8_t tlv_type = 0;
  uint8_t tlv_len = 0;
  uint8_t tlv_buf[BR_REPLY_MAX + 1];
  size_t tlv_idx = 0;

  for (;;) {
    const int n = uart_read_bytes(BR_UART, buf, sizeof(buf), pdMS_TO_TICKS(50));
    for (int i = 0; i < n; i++) {
      const uint8_t b = buf[i];

      switch (phase) {
        case RX_MAGIC: {
          if (b == FR_MAGIC) phase = RX_TYPE;
          break;
        }
        case RX_TYPE: {
          if (b < FR_TLV_THRESHOLD) {
            fr[0] = b;
            fr_idx = 1;
            phase = RX_FIXED;
          } else {
            tlv_type = b;
            phase = RX_TLV_LEN;
          }
          break;
        }
        case RX_FIXED: {
          fr[fr_idx++] = b;
          if (fr_idx < FR_SIZE - 1) break; /* 还需 [pin, vH, vL, chk] */
          /* 5 字节收集完毕，校验 */
          phase = RX_MAGIC;
          const uint8_t type = fr[0];
          const uint8_t pin  = fr[1];
          const uint8_t vH   = fr[2];
          const uint8_t vL   = fr[3];
          const uint8_t chk  = (uint8_t)(FR_MAGIC ^ type ^ pin ^ vH ^ vL);
          if (chk != fr[4]) break; /* 坏帧丢弃 */
          if (type == FR_GPIO_INPUT) {
            br_apply_input(pin, vL);
          } else if (type == FR_ADC_INPUT) {
            if (pin < SOC_GPIO_PIN_COUNT) {
              const uint16_t val = (uint16_t)(((uint16_t)vH << 8) | (uint16_t)vL);
              s_analog_inject[pin] = (int16_t)(val & 0x0FFFu); /* 钳位 12 位 */
            }
          }
          break;
        }
        case RX_TLV_LEN: {
          tlv_len = b;
          tlv_idx = 0;
          phase = RX_TLV_PAYLOAD;
          break;
        }
        case RX_TLV_PAYLOAD: {
          if (tlv_idx < sizeof(tlv_buf)) {
            tlv_buf[tlv_idx++] = b;
          } else {
            /* 溢出：丢弃整帧并重同步 */
            phase = RX_MAGIC;
            break;
          }
          if (tlv_idx < (size_t)tlv_len + 1) break; /* 还需 payload[len] + chk[1] */
          /* 收集完毕，校验 */
          phase = RX_MAGIC;
          const uint8_t chk = tlv_buf[tlv_len];
          uint8_t xor = (uint8_t)(FR_MAGIC ^ tlv_type ^ tlv_len);
          for (size_t k = 0; k < tlv_len; k++) xor ^= tlv_buf[k];
          if ((xor & 0xff) != chk) break; /* 坏帧丢弃 */
          br_handle_reply(tlv_type, tlv_buf, tlv_len);
          break;
        }
      }
    }
  }
}

/* M8 I2C 事务发送 + 阻塞等待回复（shim 上下文调用） */
size_t br_i2c_txn(uint8_t addr, uint8_t dir, const uint8_t *wdata, uint8_t wlen,
                  uint8_t *rbuf, uint8_t rlen_cap) {
  br_init();
  if (s_reply_sem == NULL) return 0;
  /* ISR 内不阻塞（uart_write_bytes 非 ISR-safe，且信号量不可在 ISR 内操作） */
  if (xPortInIsrContext() != pdFALSE) return 0;

  /* 构造 payload: addr | dir | wlen | wdata[wlen] */
  uint8_t payload[3 + 255];
  size_t plen = 0;
  payload[plen++] = (uint8_t)(addr & 0x7f);
  payload[plen++] = dir ? 1u : 0u;
  payload[plen++] = wlen;
  for (uint8_t i = 0; i < wlen; i++) payload[plen++] = wdata[i];

  /* 排空信号量并复位回复槽 */
  while (xSemaphoreTake(s_reply_sem, 0) == pdTRUE) { /* drain */ }
  s_reply_len = 0;

  br_send_tlv(FR_I2C_TXN, payload, (uint8_t)plen);

  /* 阻塞等待 SENSOR_REPLY，50ms 超时 */
  if (xSemaphoreTake(s_reply_sem, pdMS_TO_TICKS(BR_REPLY_TIMEOUT_MS)) != pdTRUE) {
    return 0;
  }

  size_t copy = s_reply_len;
  if (copy > rlen_cap) copy = rlen_cap;
  for (size_t i = 0; i < copy; i++) rbuf[i] = s_reply_buf[i];
  return copy;
}

/* M8 SPI 事务发送 + 阻塞等待回复（shim 上下文调用） */
size_t br_spi_txn(uint8_t cs, const uint8_t *wdata, uint8_t wlen,
                  uint8_t *rbuf, uint8_t rlen_cap) {
  br_init();
  if (s_reply_sem == NULL) return 0;
  if (xPortInIsrContext() != pdFALSE) return 0;

  /* 构造 payload: cs | wlen | wdata[wlen] */
  uint8_t payload[2 + 255];
  size_t plen = 0;
  payload[plen++] = cs;
  payload[plen++] = wlen;
  for (uint8_t i = 0; i < wlen; i++) payload[plen++] = wdata[i];

  while (xSemaphoreTake(s_reply_sem, 0) == pdTRUE) { /* drain */ }
  s_reply_len = 0;

  br_send_tlv(FR_SPI_TXN, payload, (uint8_t)plen);

  if (xSemaphoreTake(s_reply_sem, pdMS_TO_TICKS(BR_REPLY_TIMEOUT_MS)) != pdTRUE) {
    return 0;
  }

  size_t copy = s_reply_len;
  if (copy > rlen_cap) copy = rlen_cap;
  for (size_t i = 0; i < copy; i++) rbuf[i] = s_reply_buf[i];
  return copy;
}

/* M8 后续：DHT22 请求发送 + 阻塞等待回复 */
/* 返回 1 成功（out_temp_raw/out_hum_raw 写入），0 失败/超时 */
int br_dht22_txn(uint8_t pin, uint16_t *out_temp_raw, uint16_t *out_hum_raw) {
  br_init();
  if (s_reply_sem == NULL) return 0;
  if (xPortInIsrContext() != pdFALSE) return 0;

  /* payload: pin (1 byte) */
  uint8_t payload = pin;

  while (xSemaphoreTake(s_reply_sem, 0) == pdTRUE) { /* drain */ }
  s_reply_len = 0;

  br_send_tlv(FR_DHT22_TXN, &payload, 1);

  if (xSemaphoreTake(s_reply_sem, pdMS_TO_TICKS(BR_REPLY_TIMEOUT_MS)) != pdTRUE) {
    return 0;
  }

  /* DHT22_REPLY data 格式（4 bytes）：tempRaw_hi | tempRaw_lo | humRaw_hi | humRaw_lo */
  if (s_reply_len < 4) return 0;
  if (out_temp_raw != NULL) {
    *out_temp_raw = (uint16_t)(s_reply_buf[0] << 8) | s_reply_buf[1];
  }
  if (out_hum_raw != NULL) {
    *out_hum_raw = (uint16_t)(s_reply_buf[2] << 8) | s_reply_buf[3];
  }
  return 1;
}

/* ---- HAL 强定义（覆盖 core 的 weak alias，统一进桥） ---- */

/* Arduino mode 常量（esp32-hal-gpio.h 3.x）：INPUT=0x01 OUTPUT=0x03
 * PULLUP=0x04 INPUT_PULLUP=0x05 PULLDOWN=0x08 INPUT_PULLDOWN=0x09 —— 按位测试 */
#define GLUE_MODE_PULLUP_BIT   0x04u
#define GLUE_MODE_PULLDOWN_BIT 0x08u

void pinMode(uint8_t pin, uint8_t mode) {
  __pinMode(pin, mode);
  br_init();
  if (pin < SOC_GPIO_PIN_COUNT) {
    if (mode & GLUE_MODE_PULLUP_BIT) s_pull[pin] = 1;
    else if (mode & GLUE_MODE_PULLDOWN_BIT) s_pull[pin] = 0;
    else s_pull[pin] = -1;
  }
  br_report(FR_PIN_MODE, pin, (uint16_t)mode);
}

void digitalWrite(uint8_t pin, uint8_t val) {
  __digitalWrite(pin, val);
  br_init();
  br_report(FR_GPIO_WRITE, pin, val ? 1u : 0u);
}

int digitalRead(uint8_t pin) {
  br_init();
  if (pin < SOC_GPIO_PIN_COUNT && s_inject[pin] >= 0) return s_inject[pin];
  /* QEMU 不模拟内部上/下拉：悬空输入按固件 pull 声明返回（幻象按下修复，M7 前实测） */
  if (pin < SOC_GPIO_PIN_COUNT && s_pull[pin] >= 0) return s_pull[pin];
  return __digitalRead(pin);
}

/* ---- analogWrite / analogWriteFrequency / analogRead（M7 PWM + ADC glue） ---- */
/*
 * ⚠️ esp32 core 3.3.10 esp32-hal-ledc.c 直接定义 analogWrite / analogWriteFrequency
 * （非 weak alias、也未暴露 __analogWrite / __analogWriteFrequency 强符号），
 * 因此 glue 不能转调、只能自己驱动 LEDC 硬件（通过 ESP-IDF ledc* C 接口），同时
 * 保持与 Arduino 头文件签名 + 默认行为对齐：8bit 分辨率、默认 1kHz。
 * 链接：sketch 中的 esp32sim_bridge.c.o 链接顺序先于 core.a，本强定义覆盖核心实现。
 */

/** 跟踪每个引脚最近设置/生效的频率（Hz）：0=尚未设置（首次 analogWrite 走默认值） */
static volatile uint32_t s_analog_freq[SOC_GPIO_PIN_COUNT];
#define BR_ANALOG_RESOLUTION 8u   /* 与 core 默认 8bit 对齐（0–255） */
#define BR_ANALOG_DEFAULT_FREQ 1000u /* 与 core analog_frequency 默认值一致 */

void analogWrite(uint8_t pin, int value) {
  br_init();
  if (pin >= SOC_GPIO_PIN_COUNT) return;

  /* 参数钳位：Arduino 文档 analogWrite value=0–255；负数当 0，>255 当 255 */
  uint32_t v;
  if (value < 0) v = 0u;
  else if (value > 255) v = 255u;
  else v = (uint32_t)value;

  /* lazy attach：该引脚尚未启用 LEDC 时，按当前记录频率 / 默认值 attach。 */
  if (s_analog_freq[pin] == 0u) {
    const uint32_t f_default = BR_ANALOG_DEFAULT_FREQ;
    const bool ok = ledcAttach(pin, f_default, BR_ANALOG_RESOLUTION);
    if (!ok) {
      /* attach 失败：不抛异常（与 core 行为一致），不上报帧（同 log_e 语义下静默） */
      return;
    }
    s_analog_freq[pin] = f_default;
    /* 首次启用：上报 PWM_FREQ 帧（与之前转调 __analogWrite + sent==0 补发同行为） */
    br_report(FR_PWM_FREQ, pin, (uint16_t)f_default);
  }

  /* 驱动 LEDC 硬件；esp32-hal-ledc.c 中同样走 ledcWrite(pin,value) */
  (void)ledcWrite(pin, v);

  /* 桥上报：8 位 (0–255) → 10 位归一化（×4 左移 2 位，上限 255×4=1020） */
  const uint16_t duty10 = (uint16_t)(v * 4u);
  br_report(FR_PWM_WRITE, pin, duty10);
}

void analogWriteFrequency(uint8_t pin, uint32_t freq) {
  br_init();
  if (pin >= SOC_GPIO_PIN_COUNT) return;
  if (freq == 0u) {
    /* core: if (!freq) { ledcWrite(pin,0); return; } ——保持同语义 */
    (void)ledcWrite(pin, 0);
    s_pwm_freq_sent[pin] = 0u;
    return;
  }

  uint32_t applied = freq;
  if (s_analog_freq[pin] == 0u) {
    /* 尚未 attach：先用 freq / 默认 8bit 分辨率 attach，返回实际生效频率 */
    const bool ok = ledcAttach(pin, freq, BR_ANALOG_RESOLUTION);
    if (!ok) {
      return; /* 失败静默（与 core 同） */
    }
    s_analog_freq[pin] = freq;
    /* applied：ledcReadFreq(pin) 会通过 periman bus->timer_num 内部调用
     * ledc_get_freq，避免 glue 直接依赖 ledc_channel_handle_t 不透明结构字段
     * （esp32-hal-ledc.c 仅在本 TU 内 malloc 结构，glue 只依赖公开 API）。 */
    {
      uint32_t rd = ledcReadFreq(pin);
      if (rd != 0u) applied = rd;
    }
  } else {
    /* 已启用：尝试切换频率（8bit 分辨率对齐 core analog_resolution） */
    uint32_t got = ledcChangeFrequency(pin, freq, BR_ANALOG_RESOLUTION);
    if (got == 0u) {
      /* 切换失败：不修改记录（与 core：log_e + return; 同语义） */
      return;
    }
    applied = got;
    s_analog_freq[pin] = freq; /* core 同步 analog_frequency = freq（无论是否生效于该引脚） */
  }

  /* 上报 PWM_FREQ：16 位域，上限 65535 */
  const uint16_t f16 = (applied > 65535u) ? (uint16_t)65535u : (uint16_t)applied;
  s_pwm_freq_sent[pin] = f16;
  br_report(FR_PWM_FREQ, pin, f16);
}

uint16_t analogRead(uint8_t pin) {
  br_init();
  /* QEMU Espressif fork 不模拟 ADC 外设：转调 __analogRead 会进入
   * adc_oneshot_ll_get_event 等待 ADC 完成事件，QEMU 未实现该寄存器 →
   * "Cache disabled but cached memory region accessed" panic（Core 1
   * backtrace 落 adc_oneshot_ll_get_event → __analogRead → analogRead → loop）。
   * 与 06-§3 "QEMU 不模拟 GPIO 内部上/下拉" 同源，扩展为 "QEMU 不模拟 ADC"。
   * 05-§1.6 E3 已规定无注入时返回 0（与 PinBus.adcRead 行为一致），因此这里
   * 无注入短路返回 0，永不转调 __analogRead。 */
  if (pin < SOC_GPIO_PIN_COUNT && s_analog_inject[pin] >= 0) {
    return (uint16_t)s_analog_inject[pin];
  }
  return 0;
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
