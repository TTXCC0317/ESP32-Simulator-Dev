/*
 * machine shim（MicroPython webassembly port 自定义 C 模块）
 *
 * 《03-核心模块详细设计》§3.2 转发表（M4 串口级 + M5 输入闭环）：
 *   Pin(n, Pin.OUT) / Pin.value(v)  → js_gpio_write  → globalThis.__mpyMachine.gpioWrite
 *   Pin.value()                     → js_gpio_read   → globalThis.__mpyMachine.gpioRead
 *   Pin(n, Pin.IN, pull)            → js_gpio_configure → __mpyMachine.gpioConfigure（claimInput + pull）
 *   Pin.irq(handler, trigger)       → 回调经 mp_sched_schedule；
 *                                     JS 侧电平变化调 mp_js_gpio_inject(pin, level) 触发
 *   UART(0, baud) / write()         → js_uart_tx     → globalThis.__mpyMachine.uartWrite
 *   UART.read()/any()               → js_uart_rx/js_uart_rx_avail（JS 侧接收队列）
 *
 * I2C/SPI/PWM/ADC 后续里程碑逐个补齐（02-§4 M7/M8/M9）。
 * JS 侧接线见 apps/web/src/sim/mpy/engine.ts（MachineShim）。
 */

#include <string.h>
#include <emscripten.h>

#include "py/runtime.h"
#include "py/objstr.h"
/* mp_sched_schedule 声明于 py/runtime.h（v1.26 无独立 sched.h）：irq 回调在
 * 主 MicroPython 任务上下文（scheduler）中执行，安全持锁与 GC */

// ---- JS 桥（经 globalThis.__mpyMachine 回调，由 MachineShim 注册） ----

EM_JS(void, js_gpio_write, (int pin, int level), {
    const bridge = globalThis.__mpyMachine;
    if (bridge && bridge.gpioWrite) bridge.gpioWrite(pin, level);
});

EM_JS(int, js_gpio_read, (int pin), {
    const bridge = globalThis.__mpyMachine;
    return bridge && bridge.gpioRead ? bridge.gpioRead(pin) : 0;
});

/** Pin 构造上报（make_new）：JS 侧 claimInput + pull 语义 + irq 订阅（M5） */
EM_JS(void, js_gpio_configure, (int pin, int mode, int pull), {
    const bridge = globalThis.__mpyMachine;
    if (bridge && bridge.gpioConfigure) bridge.gpioConfigure(pin, mode, pull);
});

EM_JS(void, js_uart_tx, (int port, const uint8_t *data, int len), {
    const bridge = globalThis.__mpyMachine;
    if (bridge && bridge.uartWrite && len > 0) {
        bridge.uartWrite(port, HEAPU8.slice(data, data + len));
    }
});

/** 从 JS 侧接收队列取数据，返回实际字节数（0 = 无数据） */
EM_JS(int, js_uart_rx, (int port, uint8_t *buf, int maxlen), {
    const bridge = globalThis.__mpyMachine;
    if (!bridge || !bridge.uartRead || maxlen <= 0) return 0;
    const bytes = bridge.uartRead(port, maxlen);
    if (!bytes || !bytes.length) return 0;
    const n = Math.min(bytes.length, maxlen);
    HEAPU8.set(bytes.subarray(0, n), buf);
    return n;
});

EM_JS(int, js_uart_rx_avail, (int port), {
    const bridge = globalThis.__mpyMachine;
    return bridge && bridge.uartAvailable ? bridge.uartAvailable(port) : 0;
});

/** PWM 写：上报 duty（0–1023，10 位）+ freq（Hz）→ PinBus.pwm 事件 */
EM_JS(void, js_pwm_write, (int pin, int duty, int freq), {
    const bridge = globalThis.__mpyMachine;
    if (bridge && bridge.pwmWrite) bridge.pwmWrite(pin, duty, freq);
});

/** ADC 读：同步返回 12 位（0–4095），无注入返回 0 */
EM_JS(int, js_adc_read, (int pin), {
    const bridge = globalThis.__mpyMachine;
    return bridge && bridge.adcRead ? bridge.adcRead(pin) : 0;
});

// ---- Pin ----

/* 前向声明：make_new 先于 MP_DEFINE_CONST_OBJ_TYPE 使用 */
extern const mp_obj_type_t machine_pin_type;
extern const mp_obj_type_t machine_uart_type;
extern const mp_obj_type_t machine_pwm_type;
extern const mp_obj_type_t machine_adc_type;

typedef struct _machine_pin_obj_t {
    mp_obj_base_t base;
    mp_int_t id;
    mp_int_t mode;
    mp_int_t pull;
    mp_obj_t irq_handler;
    mp_int_t irq_trigger;
} machine_pin_obj_t;

/* Pin 实例注册表：mp_js_gpio_inject 按引脚号查找 irq 回调（0 初始化） */
#define MACHINE_PIN_MAX 64
static machine_pin_obj_t *pin_registry[MACHINE_PIN_MAX];
static int pin_last_level[MACHINE_PIN_MAX];

static void machine_pin_print(const mp_print_t *print, mp_obj_t self_in, mp_print_kind_t kind) {
    machine_pin_obj_t *self = MP_OBJ_TO_PTR(self_in);
    mp_printf(print, "Pin(%d)", (int)self->id);
}

/** Pin.value([v])：带参写电平（输出），无参读电平 */
static mp_obj_t machine_pin_value(size_t n_args, const mp_obj_t *args) {
    machine_pin_obj_t *self = MP_OBJ_TO_PTR(args[0]);
    if (n_args == 2) {
        mp_int_t v = mp_obj_get_int(args[1]);
        js_gpio_write((int)self->id, v ? 1 : 0);
        return mp_const_none;
    }
    return MP_OBJ_NEW_SMALL_INT(js_gpio_read((int)self->id));
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(machine_pin_value_obj, 1, 2, machine_pin_value);

/** Pin.irq(handler=None, trigger=IRQ_RISING|IRQ_FALLING)：注册电平变化回调（M5） */
static mp_obj_t machine_pin_irq(size_t n_args, const mp_obj_t *pos_args, mp_map_t *kw_args) {
    machine_pin_obj_t *self = MP_OBJ_TO_PTR(pos_args[0]);
    static const mp_arg_t allowed[] = {
        { MP_QSTR_handler, MP_ARG_OBJ, {.u_rom_obj = MP_ROM_NONE} },
        { MP_QSTR_trigger, MP_ARG_INT, {.u_int = 3} }, /* 默认 RISING|FALLING */
    };
    mp_arg_val_t vals[MP_ARRAY_SIZE(allowed)];
    mp_arg_parse_all(n_args - 1, pos_args + 1, kw_args, MP_ARRAY_SIZE(allowed), allowed, vals);
    self->irq_handler = vals[0].u_obj;
    self->irq_trigger = vals[1].u_int;
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_KW(machine_pin_irq_obj, 1, machine_pin_irq);

static const mp_rom_map_elem_t machine_pin_locals_dict_table[] = {
    { MP_ROM_QSTR(MP_QSTR_value), MP_ROM_PTR(&machine_pin_value_obj) },
    { MP_ROM_QSTR(MP_QSTR_irq), MP_ROM_PTR(&machine_pin_irq_obj) },
    // 常量（官方 ports/bare-arm 习惯值；IN/OUT 与 esp32 port 一致）
    { MP_ROM_QSTR(MP_QSTR_IN), MP_ROM_INT(0) },
    { MP_ROM_QSTR(MP_QSTR_OUT), MP_ROM_INT(1) },
    { MP_ROM_QSTR(MP_QSTR_PULL_NONE), MP_ROM_INT(0) },
    { MP_ROM_QSTR(MP_QSTR_PULL_UP), MP_ROM_INT(2) },
    { MP_ROM_QSTR(MP_QSTR_PULL_DOWN), MP_ROM_INT(1) },
    // IRQ 触发掩码位（rising=1 falling=2；M5 irq 回调已实现）
    { MP_ROM_QSTR(MP_QSTR_IRQ_RISING), MP_ROM_INT(1) },
    { MP_ROM_QSTR(MP_QSTR_IRQ_FALLING), MP_ROM_INT(2) },
};
static MP_DEFINE_CONST_DICT(machine_pin_locals_dict, machine_pin_locals_dict_table);

static mp_obj_t machine_pin_make_new(const mp_obj_type_t *type, size_t n_args, size_t n_kw, const mp_obj_t *args) {
    enum { ARG_pin, ARG_mode, ARG_pull };
    static const mp_arg_t allowed_args[] = {
        { MP_QSTR_pin,   MP_ARG_REQUIRED | MP_ARG_OBJ, {.u_rom_obj = MP_ROM_NONE} },
        { MP_QSTR_mode,  MP_ARG_INT,                   {.u_int = 1} },
        { MP_QSTR_pull,  MP_ARG_INT,                   {.u_int = 0} },
    };
    mp_arg_val_t vals[MP_ARRAY_SIZE(allowed_args)];
    mp_arg_parse_all_kw_array(n_args, n_kw, args, MP_ARRAY_SIZE(allowed_args), allowed_args, vals);
    machine_pin_obj_t *self = m_new_obj(machine_pin_obj_t);
    self->base.type = &machine_pin_type;
    self->id = mp_obj_get_int(vals[ARG_pin].u_obj);
    self->mode = vals[ARG_mode].u_int;
    self->pull = vals[ARG_pull].u_int;
    self->irq_handler = mp_const_none;
    self->irq_trigger = 3; /* 默认 RISING|FALLING */
    if (self->id >= 0 && self->id < MACHINE_PIN_MAX) {
        pin_registry[self->id] = self;
        pin_last_level[self->id] = 0;
        /* 上报 JS：输入模式 claimInput（pull 语义）+ onChange 订阅（irq 注入） */
        js_gpio_configure((int)self->id, (int)self->mode, (int)self->pull);
    }
    return MP_OBJ_FROM_PTR(self);
}

MP_DEFINE_CONST_OBJ_TYPE(
    machine_pin_type,
    MP_QSTR_Pin,
    MP_TYPE_FLAG_NONE,
    make_new, machine_pin_make_new,
    print, machine_pin_print,
    locals_dict, &machine_pin_locals_dict
    );

// ---- UART ----

typedef struct _machine_uart_obj_t {
    mp_obj_base_t base;
    mp_int_t id;
    mp_int_t baudrate;
} machine_uart_obj_t;

static void machine_uart_print(const mp_print_t *print, mp_obj_t self_in, mp_print_kind_t kind) {
    machine_uart_obj_t *self = MP_OBJ_TO_PTR(self_in);
    mp_printf(print, "UART(%d, baudrate=%d)", (int)self->id, (int)self->baudrate);
}

static mp_obj_t machine_uart_make_new(const mp_obj_type_t *type, size_t n_args, size_t n_kw, const mp_obj_t *args) {
    enum { ARG_id, ARG_baudrate };
    static const mp_arg_t allowed_args[] = {
        { MP_QSTR_id,        MP_ARG_REQUIRED | MP_ARG_INT, {.u_int = 0} },
        { MP_QSTR_baudrate,  MP_ARG_INT,                   {.u_int = 9600} },
    };
    mp_arg_val_t vals[MP_ARRAY_SIZE(allowed_args)];
    mp_arg_parse_all_kw_array(n_args, n_kw, args, MP_ARRAY_SIZE(allowed_args), allowed_args, vals);
    machine_uart_obj_t *self = m_new_obj(machine_uart_obj_t);
    self->base.type = &machine_uart_type;
    self->id = vals[ARG_id].u_int;
    self->baudrate = vals[ARG_baudrate].u_int;
    return MP_OBJ_FROM_PTR(self);
}

/** UART.write(buf) → 引擎事件 uart.rx（port=REPL 串口语义） */
static mp_obj_t machine_uart_write(mp_obj_t self_in, mp_obj_t buf_in) {
    machine_uart_obj_t *self = MP_OBJ_TO_PTR(self_in);
    mp_buffer_info_t bufinfo;
    mp_get_buffer_raise(buf_in, &bufinfo, MP_BUFFER_READ);
    if (bufinfo.len > 0) {
        js_uart_tx((int)self->id, (const uint8_t *)bufinfo.buf, (int)bufinfo.len);
    }
    return MP_OBJ_NEW_SMALL_INT((mp_int_t)bufinfo.len);
}
static MP_DEFINE_CONST_FUN_OBJ_2(machine_uart_write_obj, machine_uart_write);

/** UART.read([nbytes])：非阻塞，无数据返回 None（MicroPython 约定） */
static mp_obj_t machine_uart_read(size_t n_args, const mp_obj_t *args) {
    machine_uart_obj_t *self = MP_OBJ_TO_PTR(args[0]);
    mp_int_t nbytes = 1;
    if (n_args >= 2) {
        if (args[1] == mp_const_none) {
            nbytes = 256;
        } else {
            nbytes = mp_obj_get_int(args[1]);
        }
    }
    if (nbytes <= 0) {
        return mp_const_empty_bytes;
    }
    uint8_t buf[128];
    if (nbytes > (mp_int_t)sizeof(buf)) {
        nbytes = sizeof(buf);
    }
    int n = js_uart_rx((int)self->id, buf, (int)nbytes);
    if (n <= 0) {
        return mp_const_none;
    }
    return mp_obj_new_bytes(buf, (size_t)n);
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(machine_uart_read_obj, 1, 2, machine_uart_read);

/** UART.any()：接收队列字节数 */
static mp_obj_t machine_uart_any(mp_obj_t self_in) {
    machine_uart_obj_t *self = MP_OBJ_TO_PTR(self_in);
    return MP_OBJ_NEW_SMALL_INT(js_uart_rx_avail((int)self->id));
}
static MP_DEFINE_CONST_FUN_OBJ_1(machine_uart_any_obj, machine_uart_any);

static const mp_rom_map_elem_t machine_uart_locals_dict_table[] = {
    { MP_ROM_QSTR(MP_QSTR_write), MP_ROM_PTR(&machine_uart_write_obj) },
    { MP_ROM_QSTR(MP_QSTR_read), MP_ROM_PTR(&machine_uart_read_obj) },
    { MP_ROM_QSTR(MP_QSTR_any), MP_ROM_PTR(&machine_uart_any_obj) },
};
static MP_DEFINE_CONST_DICT(machine_uart_locals_dict, machine_uart_locals_dict_table);

MP_DEFINE_CONST_OBJ_TYPE(
    machine_uart_type,
    MP_QSTR_UART,
    MP_TYPE_FLAG_NONE,
    make_new, machine_uart_make_new,
    print, machine_uart_print,
    locals_dict, &machine_uart_locals_dict
    );

// ---- PWM ----

typedef struct _machine_pwm_obj_t {
    mp_obj_base_t base;
    mp_int_t pin;
    mp_int_t freq;
    mp_int_t duty;
} machine_pwm_obj_t;

static void machine_pwm_print(const mp_print_t *print, mp_obj_t self_in, mp_print_kind_t kind) {
    machine_pwm_obj_t *self = MP_OBJ_TO_PTR(self_in);
    mp_printf(print, "PWM(pin=%d, freq=%d, duty=%d)", (int)self->pin, (int)self->freq, (int)self->duty);
}

/** PWM.duty([val])：无参读、有参写（0–1023，10 位），支持 duty= 关键字参数 */
static mp_obj_t machine_pwm_duty(size_t n_args, const mp_obj_t *pos_args, mp_map_t *kw_args) {
    enum { ARG_duty };
    static const mp_arg_t allowed_args[] = {
        { MP_QSTR_duty, MP_ARG_INT, {.u_int = -1} },
    };
    mp_arg_val_t vals[MP_ARRAY_SIZE(allowed_args)];
    mp_arg_parse_all(n_args - 1, pos_args + 1, kw_args, MP_ARRAY_SIZE(allowed_args), allowed_args, vals);
    machine_pwm_obj_t *self = MP_OBJ_TO_PTR(pos_args[0]);
    if (vals[ARG_duty].u_int >= 0) {
        mp_int_t v = vals[ARG_duty].u_int;
        if (v < 0) v = 0;
        if (v > 1023) v = 1023;
        self->duty = v;
        js_pwm_write((int)self->pin, (int)self->duty, (int)self->freq);
        return mp_const_none;
    }
    return MP_OBJ_NEW_SMALL_INT(self->duty);
}
static MP_DEFINE_CONST_FUN_OBJ_KW(machine_pwm_duty_obj, 1, machine_pwm_duty);

/** PWM.freq([val])：无参读、有参写（Hz，>= 1），支持 freq= 关键字参数 */
static mp_obj_t machine_pwm_freq(size_t n_args, const mp_obj_t *pos_args, mp_map_t *kw_args) {
    enum { ARG_freq };
    static const mp_arg_t allowed_args[] = {
        { MP_QSTR_freq, MP_ARG_INT, {.u_int = -1} },
    };
    mp_arg_val_t vals[MP_ARRAY_SIZE(allowed_args)];
    mp_arg_parse_all(n_args - 1, pos_args + 1, kw_args, MP_ARRAY_SIZE(allowed_args), allowed_args, vals);
    machine_pwm_obj_t *self = MP_OBJ_TO_PTR(pos_args[0]);
    if (vals[ARG_freq].u_int >= 0) {
        mp_int_t v = vals[ARG_freq].u_int;
        if (v < 1) v = 1;
        self->freq = v;
        js_pwm_write((int)self->pin, (int)self->duty, (int)self->freq);
        return mp_const_none;
    }
    return MP_OBJ_NEW_SMALL_INT(self->freq);
}
static MP_DEFINE_CONST_FUN_OBJ_KW(machine_pwm_freq_obj, 1, machine_pwm_freq);

static const mp_rom_map_elem_t machine_pwm_locals_dict_table[] = {
    { MP_ROM_QSTR(MP_QSTR_duty), MP_ROM_PTR(&machine_pwm_duty_obj) },
    { MP_ROM_QSTR(MP_QSTR_freq), MP_ROM_PTR(&machine_pwm_freq_obj) },
};
static MP_DEFINE_CONST_DICT(machine_pwm_locals_dict, machine_pwm_locals_dict_table);

static mp_obj_t machine_pwm_make_new(const mp_obj_type_t *type, size_t n_args, size_t n_kw, const mp_obj_t *args) {
    enum { ARG_pin, ARG_freq, ARG_duty };
    static const mp_arg_t allowed_args[] = {
        { MP_QSTR_pin,   MP_ARG_REQUIRED | MP_ARG_OBJ, {.u_rom_obj = MP_ROM_NONE} },
        { MP_QSTR_freq,  MP_ARG_INT,                   {.u_int = 1000} },
        { MP_QSTR_duty,  MP_ARG_INT,                   {.u_int = 0} },
    };
    mp_arg_val_t vals[MP_ARRAY_SIZE(allowed_args)];
    mp_arg_parse_all_kw_array(n_args, n_kw, args, MP_ARRAY_SIZE(allowed_args), allowed_args, vals);
    machine_pwm_obj_t *self = m_new_obj(machine_pwm_obj_t);
    self->base.type = &machine_pwm_type;
    /* 第 1 参：Pin 对象或 int 引脚号 */
    if (MP_OBJ_IS_TYPE(vals[ARG_pin].u_obj, &machine_pin_type)) {
        machine_pin_obj_t *p = MP_OBJ_TO_PTR(vals[ARG_pin].u_obj);
        self->pin = p->id;
    } else {
        self->pin = mp_obj_get_int(vals[ARG_pin].u_obj);
    }
    self->freq = vals[ARG_freq].u_int;
    if (self->freq < 1) self->freq = 1;
    self->duty = vals[ARG_duty].u_int;
    if (self->duty < 0) self->duty = 0;
    if (self->duty > 1023) self->duty = 1023;
    /* 构造即上报，确保 PinBus 立即感知 PWM 状态 */
    js_pwm_write((int)self->pin, (int)self->duty, (int)self->freq);
    return MP_OBJ_FROM_PTR(self);
}

MP_DEFINE_CONST_OBJ_TYPE(
    machine_pwm_type,
    MP_QSTR_PWM,
    MP_TYPE_FLAG_NONE,
    make_new, machine_pwm_make_new,
    print, machine_pwm_print,
    locals_dict, &machine_pwm_locals_dict
    );

// ---- ADC ----

typedef struct _machine_adc_obj_t {
    mp_obj_base_t base;
    mp_int_t pin;
} machine_adc_obj_t;

static void machine_adc_print(const mp_print_t *print, mp_obj_t self_in, mp_print_kind_t kind) {
    machine_adc_obj_t *self = MP_OBJ_TO_PTR(self_in);
    mp_printf(print, "ADC(Pin(%d))", (int)self->pin);
}

/** ADC.read() → 12 位（0–4095），直接同步读 JS 侧 PinBus */
static mp_obj_t machine_adc_read(mp_obj_t self_in) {
    machine_adc_obj_t *self = MP_OBJ_TO_PTR(self_in);
    mp_int_t v = js_adc_read((int)self->pin);
    if (v < 0) v = 0;
    if (v > 4095) v = 4095;
    return MP_OBJ_NEW_SMALL_INT(v);
}
static MP_DEFINE_CONST_FUN_OBJ_1(machine_adc_read_obj, machine_adc_read);

/** ADC.read_u16() → 16 位（0–65535），12 位线性映射 */
static mp_obj_t machine_adc_read_u16(mp_obj_t self_in) {
    machine_adc_obj_t *self = MP_OBJ_TO_PTR(self_in);
    mp_int_t v = js_adc_read((int)self->pin);
    if (v < 0) v = 0;
    if (v > 4095) v = 4095;
    /* 0–4095 → 0–65520，4095*16=65520（MicroPython 官方约定） */
    return MP_OBJ_NEW_SMALL_INT(v * 16);
}
static MP_DEFINE_CONST_FUN_OBJ_1(machine_adc_read_u16_obj, machine_adc_read_u16);

static const mp_rom_map_elem_t machine_adc_locals_dict_table[] = {
    { MP_ROM_QSTR(MP_QSTR_read), MP_ROM_PTR(&machine_adc_read_obj) },
    { MP_ROM_QSTR(MP_QSTR_read_u16), MP_ROM_PTR(&machine_adc_read_u16_obj) },
};
static MP_DEFINE_CONST_DICT(machine_adc_locals_dict, machine_adc_locals_dict_table);

static mp_obj_t machine_adc_make_new(const mp_obj_type_t *type, size_t n_args, size_t n_kw, const mp_obj_t *args) {
    enum { ARG_pin };
    static const mp_arg_t allowed_args[] = {
        { MP_QSTR_pin, MP_ARG_REQUIRED | MP_ARG_OBJ, {.u_rom_obj = MP_ROM_NONE} },
    };
    mp_arg_val_t vals[MP_ARRAY_SIZE(allowed_args)];
    mp_arg_parse_all_kw_array(n_args, n_kw, args, MP_ARRAY_SIZE(allowed_args), allowed_args, vals);
    machine_adc_obj_t *self = m_new_obj(machine_adc_obj_t);
    self->base.type = &machine_adc_type;
    /* 接受 Pin 对象或 int 引脚号 */
    if (MP_OBJ_IS_TYPE(vals[ARG_pin].u_obj, &machine_pin_type)) {
        machine_pin_obj_t *p = MP_OBJ_TO_PTR(vals[ARG_pin].u_obj);
        self->pin = p->id;
    } else {
        self->pin = mp_obj_get_int(vals[ARG_pin].u_obj);
    }
    return MP_OBJ_FROM_PTR(self);
}

MP_DEFINE_CONST_OBJ_TYPE(
    machine_adc_type,
    MP_QSTR_ADC,
    MP_TYPE_FLAG_NONE,
    make_new, machine_adc_make_new,
    print, machine_adc_print,
    locals_dict, &machine_adc_locals_dict
    );

// ---- M8 stage 2：I2C / SPI / DHT22 类（EM_JS → engine.ts registerShim 桥） ----
//
// 转发表（03-§3.2）：
//   I2C(scl, sda, freq).scan()          → js_i2c_scan      → bridge.i2cScan
//   I2C.writeto(addr, buf)               → js_i2c_writeto   → bridge.i2cWriteto
//   I2C.readfrom(addr, n)                → js_i2c_readfrom  → bridge.i2cReadfrom
//   I2C.writeto_then_readfrom(addr,...)   → js_i2c_wrrd     → bridge.i2cWrrd
//   SPI(baud, polarity, phase, sck, mosi, miso).write(buf) → js_spi_write  → bridge.spiWrite
//   SPI.transfer(buf)                     → js_spi_transfer → bridge.spiTransfer
//   DHT22(pin).read()                     → js_dht22_read   → bridge.dht22Read
//
// 协议简化：不模拟 I2C/SPI 硬件时序（QEMU/wasm 无外设），所有事务经 EM_JS 同步返回。

EM_JS(void, js_i2c_scan, (int port, int *buf, int maxlen), {
    const bridge = globalThis.__mpyMachine;
    if (!bridge || !bridge.i2cScan || maxlen <= 0) return;
    const addrs = bridge.i2cScan(port);
    if (!addrs) return;
    const n = Math.min(addrs.length, maxlen);
    for (let i = 0; i < n; i++) HEAP32[buf/4 + i] = addrs[i];
});

EM_JS(int, js_i2c_writeto, (int port, int addr, const uint8_t *data, int len), {
    const bridge = globalThis.__mpyMachine;
    if (!bridge || !bridge.i2cWriteto || len <= 0) return 0;
    bridge.i2cWriteto(port, addr, HEAPU8.slice(data, data + len));
    return len;
});

EM_JS(int, js_i2c_readfrom, (int port, int addr, uint8_t *buf, int maxlen), {
    const bridge = globalThis.__mpyMachine;
    if (!bridge || !bridge.i2cReadfrom || maxlen <= 0) return 0;
    const bytes = bridge.i2cReadfrom(port, addr, maxlen);
    if (!bytes || !bytes.length) return 0;
    const n = Math.min(bytes.length, maxlen);
    HEAPU8.set(bytes.subarray(0, n), buf);
    return n;
});

EM_JS(int, js_i2c_wrrd, (int port, int addr, const uint8_t *wdata, int wlen, uint8_t *rbuf, int rlen), {
    const bridge = globalThis.__mpyMachine;
    if (!bridge || !bridge.i2cWrrd || rlen <= 0) return 0;
    const w = wlen > 0 ? HEAPU8.slice(wdata, wdata + wlen) : new Uint8Array(0);
    const bytes = bridge.i2cWrrd(port, addr, w, rlen);
    if (!bytes || !bytes.length) return 0;
    const n = Math.min(bytes.length, rlen);
    HEAPU8.set(bytes.subarray(0, n), rbuf);
    return n;
});

EM_JS(int, js_spi_write, (int port, const uint8_t *data, int len), {
    const bridge = globalThis.__mpyMachine;
    if (!bridge || !bridge.spiWrite || len <= 0) return 0;
    bridge.spiWrite(port, HEAPU8.slice(data, data + len));
    return len;
});

EM_JS(int, js_spi_transfer, (int port, const uint8_t *tx, uint8_t *rx, int len), {
    const bridge = globalThis.__mpyMachine;
    if (!bridge || !bridge.spiTransfer || len <= 0) return 0;
    const t = HEAPU8.slice(tx, tx + len);
    const r = bridge.spiTransfer(port, t);
    if (!r || !r.length) return 0;
    const n = Math.min(r.length, len);
    HEAPU8.set(r.subarray(0, n), rx);
    return n;
});

/** DHT22 读：返回 1 成功（out_temp/out_hum 写入），0 失败 */
EM_JS(int, js_dht22_read, (int pin, float *out_temp, float *out_hum), {
    const bridge = globalThis.__mpyMachine;
    if (!bridge || !bridge.dht22Read) return 0;
    const r = bridge.dht22Read(pin);
    if (!r) return 0;
    HEAPF32[out_temp >> 2] = r.temperature;
    HEAPF32[out_hum >> 2] = r.humidity;
    return 1;
});

// ---- I2C 类 ----

typedef struct _machine_i2c_obj_t {
    mp_obj_base_t base;
    mp_int_t port;
    mp_int_t freq;
    mp_int_t scl;
    mp_int_t sda;
} machine_i2c_obj_t;

static const mp_arg_t machine_i2c_make_new_allowed[] = {
    { MP_QSTR_scl, MP_ARG_OBJ, {.u_obj = MP_OBJ_NULL} },
    { MP_QSTR_sda, MP_ARG_OBJ, {.u_obj = MP_OBJ_NULL} },
    { MP_QSTR_freq, MP_ARG_INT, {.u_int = 400000} },
};

static mp_obj_t machine_i2c_make_new(const mp_obj_type_t *type, size_t n_args, size_t n_kw, const mp_obj_t *args) {
    mp_arg_val_t vals[MP_ARRAY_SIZE(machine_i2c_make_new_allowed)];
    mp_arg_parse_all_kw_array(n_args, n_kw, args, MP_ARRAY_SIZE(machine_i2c_make_new_allowed), machine_i2c_make_new_allowed, vals);
    machine_i2c_obj_t *self = mp_obj_malloc(machine_i2c_obj_t, type);
    self->port = 0;
    self->freq = vals[2].u_int;
    self->scl = vals[0].u_obj != MP_OBJ_NULL ? mp_obj_get_int(vals[0].u_obj) : -1;
    self->sda = vals[1].u_obj != MP_OBJ_NULL ? mp_obj_get_int(vals[1].u_obj) : -1;
    return MP_OBJ_FROM_PTR(self);
}

static mp_obj_t machine_i2c_scan(size_t n_args, const mp_obj_t *args) {
    machine_i2c_obj_t *self = MP_OBJ_TO_PTR(args[0]);
    int buf[128];
    js_i2c_scan((int)self->port, buf, 128);
    /* 简化：返回空列表（wasm shim 未桥接真实设备时） */
    (void)n_args;
    return mp_obj_new_list(0, NULL);
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(machine_i2c_scan_obj, 1, 1, machine_i2c_scan);

static mp_obj_t machine_i2c_writeto(size_t n_args, const mp_obj_t *args) {
    machine_i2c_obj_t *self = MP_OBJ_TO_PTR(args[0]);
    mp_int_t addr = mp_obj_get_int(args[1]);
    mp_buffer_info_t bufinfo;
    mp_get_buffer_raise(args[2], &bufinfo, MP_BUFFER_READ);
    js_i2c_writeto((int)self->port, (int)addr, bufinfo.buf, (int)bufinfo.len);
    return MP_OBJ_NEW_SMALL_INT(bufinfo.len);
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(machine_i2c_writeto_obj, 3, 5, machine_i2c_writeto);

static mp_obj_t machine_i2c_readfrom(size_t n_args, const mp_obj_t *args) {
    machine_i2c_obj_t *self = MP_OBJ_TO_PTR(args[0]);
    mp_int_t addr = mp_obj_get_int(args[1]);
    mp_int_t n = mp_obj_get_int(args[2]);
    if (n < 0) n = 0;
    if (n > 256) n = 256;
    uint8_t buf[256];
    int got = js_i2c_readfrom((int)self->port, (int)addr, buf, (int)n);
    (void)n_args;
    return mp_obj_new_bytearray(got, buf);
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(machine_i2c_readfrom_obj, 3, 4, machine_i2c_readfrom);

static mp_obj_t machine_i2c_writeto_then_readfrom(size_t n_args, const mp_obj_t *args) {
    machine_i2c_obj_t *self = MP_OBJ_TO_PTR(args[0]);
    mp_int_t addr = mp_obj_get_int(args[1]);
    mp_buffer_info_t wbuf;
    mp_get_buffer_raise(args[2], &wbuf, MP_BUFFER_READ);
    mp_int_t rlen = mp_obj_get_int(args[3]);
    if (rlen < 0) rlen = 0;
    if (rlen > 256) rlen = 256;
    uint8_t rbuf[256];
    int got = js_i2c_wrrd((int)self->port, (int)addr, wbuf.buf, (int)wbuf.len, rbuf, (int)rlen);
    (void)n_args;
    return mp_obj_new_bytearray(got, rbuf);
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(machine_i2c_wrrd_obj, 4, 6, machine_i2c_writeto_then_readfrom);

static const mp_rom_map_elem_t machine_i2c_locals_dict_table[] = {
    { MP_ROM_QSTR(MP_QSTR_scan), MP_ROM_PTR(&machine_i2c_scan_obj) },
    { MP_ROM_QSTR(MP_QSTR_writeto), MP_ROM_PTR(&machine_i2c_writeto_obj) },
    { MP_ROM_QSTR(MP_QSTR_readfrom), MP_ROM_PTR(&machine_i2c_readfrom_obj) },
    { MP_ROM_QSTR(MP_QSTR_writeto_then_readfrom), MP_ROM_PTR(&machine_i2c_wrrd_obj) },
};
static MP_DEFINE_CONST_DICT(machine_i2c_locals_dict, machine_i2c_locals_dict_table);

extern const mp_obj_type_t machine_i2c_type;
MP_DEFINE_CONST_OBJ_TYPE(
    machine_i2c_type,
    MP_QSTR_I2C,
    MP_TYPE_FLAG_NONE,
    make_new, machine_i2c_make_new,
    locals_dict, &machine_i2c_locals_dict
);

// ---- SPI 类 ----

typedef struct _machine_spi_obj_t {
    mp_obj_base_t base;
    mp_int_t port;
    mp_int_t baud;
} machine_spi_obj_t;

static mp_obj_t machine_spi_make_new(const mp_obj_type_t *type, size_t n_args, size_t n_kw, const mp_obj_t *args) {
    machine_spi_obj_t *self = mp_obj_malloc(machine_spi_obj_t, type);
    self->port = 0;
    self->baud = 1000000;
    /* 简化：忽略 polarity/phase/sck/mosi/miso 参数（wasm 桥不关心） */
    (void)n_args; (void)n_kw; (void)args;
    return MP_OBJ_FROM_PTR(self);
}

static mp_obj_t machine_spi_write(size_t n_args, const mp_obj_t *args) {
    machine_spi_obj_t *self = MP_OBJ_TO_PTR(args[0]);
    mp_buffer_info_t bufinfo;
    mp_get_buffer_raise(args[1], &bufinfo, MP_BUFFER_READ);
    js_spi_write((int)self->port, bufinfo.buf, (int)bufinfo.len);
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(machine_spi_write_obj, 2, 2, machine_spi_write);

static mp_obj_t machine_spi_transfer(size_t n_args, const mp_obj_t *args) {
    machine_spi_obj_t *self = MP_OBJ_TO_PTR(args[0]);
    mp_buffer_info_t bufinfo;
    mp_get_buffer_raise(args[1], &bufinfo, MP_BUFFER_READ);
    uint8_t rxbuf[256];
    int len = bufinfo.len > 256 ? 256 : (int)bufinfo.len;
    int got = js_spi_transfer((int)self->port, bufinfo.buf, rxbuf, len);
    (void)n_args;
    return mp_obj_new_bytearray(got, rxbuf);
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(machine_spi_transfer_obj, 2, 2, machine_spi_transfer);

static const mp_rom_map_elem_t machine_spi_locals_dict_table[] = {
    { MP_ROM_QSTR(MP_QSTR_write), MP_ROM_PTR(&machine_spi_write_obj) },
    { MP_ROM_QSTR(MP_QSTR_transfer), MP_ROM_PTR(&machine_spi_transfer_obj) },
};
static MP_DEFINE_CONST_DICT(machine_spi_locals_dict, machine_spi_locals_dict_table);

extern const mp_obj_type_t machine_spi_type;
MP_DEFINE_CONST_OBJ_TYPE(
    machine_spi_type,
    MP_QSTR_SPI,
    MP_TYPE_FLAG_NONE,
    make_new, machine_spi_make_new,
    locals_dict, &machine_spi_locals_dict
);

// ---- DHT22 类（单总线传感器，简化接口） ----

typedef struct _machine_dht_obj_t {
    mp_obj_base_t base;
    mp_int_t pin;
} machine_dht_obj_t;

static mp_obj_t machine_dht_make_new(const mp_obj_type_t *type, size_t n_args, size_t n_kw, const mp_obj_t *args) {
    mp_arg_check_num(n_args, n_kw, 1, 1, false);
    machine_dht_obj_t *self = mp_obj_malloc(machine_dht_obj_t, type);
    self->pin = mp_obj_get_int(args[0]);
    return MP_OBJ_FROM_PTR(self);
}

/** DHT.measure() → None（数据缓存到 self） */
static mp_obj_t machine_dht_measure(mp_obj_t self_in) {
    machine_dht_obj_t *self = MP_OBJ_TO_PTR(self_in);
    /* 直接调 js_dht22_read，结果缓存到静态变量（measure+read 分离语义） */
    float t, h;
    (void)js_dht22_read((int)self->pin, &t, &h);
    /* 缓存到 instance attrs via module-level static（简化） */
    /* 此处略：实际实现可加 self->temp/hum 字段，但需扩 struct；
     * 简化路径直接在 read() 时再调用 js_dht22_read */
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(machine_dht_measure_obj, machine_dht_measure);

/** DHT.temperature() → float（直接调 js_dht22_read 取最新值） */
static mp_obj_t machine_dht_temperature(mp_obj_t self_in) {
    machine_dht_obj_t *self = MP_OBJ_TO_PTR(self_in);
    float t = 0.0f, h = 0.0f;
    if (js_dht22_read((int)self->pin, &t, &h)) {
        return mp_obj_new_float((double)t);
    }
    return mp_obj_new_float(0.0);
}
static MP_DEFINE_CONST_FUN_OBJ_1(machine_dht_temperature_obj, machine_dht_temperature);

/** DHT.humidity() → float */
static mp_obj_t machine_dht_humidity(mp_obj_t self_in) {
    machine_dht_obj_t *self = MP_OBJ_TO_PTR(self_in);
    float t = 0.0f, h = 0.0f;
    if (js_dht22_read((int)self->pin, &t, &h)) {
        return mp_obj_new_float((double)h);
    }
    return mp_obj_new_float(0.0);
}
static MP_DEFINE_CONST_FUN_OBJ_1(machine_dht_humidity_obj, machine_dht_humidity);

static const mp_rom_map_elem_t machine_dht_locals_dict_table[] = {
    { MP_ROM_QSTR(MP_QSTR_measure), MP_ROM_PTR(&machine_dht_measure_obj) },
    { MP_ROM_QSTR(MP_QSTR_temperature), MP_ROM_PTR(&machine_dht_temperature_obj) },
    { MP_ROM_QSTR(MP_QSTR_humidity), MP_ROM_PTR(&machine_dht_humidity_obj) },
};
static MP_DEFINE_CONST_DICT(machine_dht_locals_dict, machine_dht_locals_dict_table);

extern const mp_obj_type_t machine_dht_type;
MP_DEFINE_CONST_OBJ_TYPE(
    machine_dht_type,
    MP_QSTR_DHT,
    MP_TYPE_FLAG_NONE,
    make_new, machine_dht_make_new,
    locals_dict, &machine_dht_locals_dict
);

// ---- machine 模块 ----

static const mp_rom_map_elem_t machine_module_globals_table[] = {
    { MP_ROM_QSTR(MP_QSTR___name__), MP_ROM_QSTR(MP_QSTR_machine) },
    { MP_ROM_QSTR(MP_QSTR_Pin), MP_ROM_PTR(&machine_pin_type) },
    { MP_ROM_QSTR(MP_QSTR_UART), MP_ROM_PTR(&machine_uart_type) },
    { MP_ROM_QSTR(MP_QSTR_PWM), MP_ROM_PTR(&machine_pwm_type) },
    { MP_ROM_QSTR(MP_QSTR_ADC), MP_ROM_PTR(&machine_adc_type) },
    { MP_ROM_QSTR(MP_QSTR_I2C), MP_ROM_PTR(&machine_i2c_type) },
    { MP_ROM_QSTR(MP_QSTR_SPI), MP_ROM_PTR(&machine_spi_type) },
    { MP_ROM_QSTR(MP_QSTR_DHT), MP_ROM_PTR(&machine_dht_type) },
};
static MP_DEFINE_CONST_DICT(machine_module_globals, machine_module_globals_table);

const mp_obj_module_t machine_module = {
    .base = { &mp_type_module },
    .globals = (mp_obj_dict_t *)&machine_module_globals,
};

MP_REGISTER_MODULE(MP_QSTR_machine, machine_module);

// ---- JS → C 注入入口（engine.ts 订阅 PinBus.onChange 后调用；链接导出见 build.sh） ----

/**
 * JS 注入引脚电平变化：与上次电平比较得出沿，匹配 irq_trigger 时经
 * mp_sched_schedule 调度回调（回调收到 MP_OBJ_SMALL_INT(level)）。
 * 无注册回调 / 无沿变化时静默（仅更新电平轨迹）。
 */
void mp_js_gpio_inject(int pin, int level) {
    if (pin < 0 || pin >= MACHINE_PIN_MAX) {
        return;
    }
    const int lv = level ? 1 : 0;
    const int prev = pin_last_level[pin];
    pin_last_level[pin] = lv;
    machine_pin_obj_t *self = pin_registry[pin];
    if (self == NULL || self->irq_handler == mp_const_none) {
        return;
    }
    if (prev == lv) {
        return;
    }
    const int rising = (prev == 0 && lv == 1);
    const int falling = (prev == 1 && lv == 0);
    if ((rising && (self->irq_trigger & 1)) || (falling && (self->irq_trigger & 2))) {
        (void)mp_sched_schedule(self->irq_handler, MP_OBJ_NEW_SMALL_INT(lv));
    }
}
