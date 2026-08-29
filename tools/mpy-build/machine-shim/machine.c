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

// ---- Pin ----

/* 前向声明：make_new 先于 MP_DEFINE_CONST_OBJ_TYPE 使用 */
extern const mp_obj_type_t machine_pin_type;
extern const mp_obj_type_t machine_uart_type;

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
    mp_arg_check_num(n_args, n_kw, 1, 3, false);
    machine_pin_obj_t *self = m_new_obj(machine_pin_obj_t);
    self->base.type = &machine_pin_type;
    self->id = mp_obj_get_int(args[0]);
    self->mode = (n_args >= 2) ? mp_obj_get_int(args[1]) : 1;
    self->pull = (n_args >= 3) ? mp_obj_get_int(args[2]) : 0;
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
    mp_arg_check_num(n_args, n_kw, 1, 2, false);
    machine_uart_obj_t *self = m_new_obj(machine_uart_obj_t);
    self->base.type = &machine_uart_type;
    self->id = mp_obj_get_int(args[0]);
    self->baudrate = (n_args >= 2) ? mp_obj_get_int(args[1]) : 9600;
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

// ---- machine 模块 ----

static const mp_rom_map_elem_t machine_module_globals_table[] = {
    { MP_ROM_QSTR(MP_QSTR___name__), MP_ROM_QSTR(MP_QSTR_machine) },
    { MP_ROM_QSTR(MP_QSTR_Pin), MP_ROM_PTR(&machine_pin_type) },
    { MP_ROM_QSTR(MP_QSTR_UART), MP_ROM_PTR(&machine_uart_type) },
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
