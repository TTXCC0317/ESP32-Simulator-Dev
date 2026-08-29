/*
 * machine shim（MicroPython webassembly port 自定义 C 模块）
 *
 * 《03-核心模块详细设计》§3.2 转发表 M4 子集：
 *   Pin(n, Pin.OUT) / Pin.value(v)  → js_gpio_write  → globalThis.__mpyMachine.gpioWrite
 *   Pin.value()                     → js_gpio_read   → globalThis.__mpyMachine.gpioRead
 *   UART(0, baud) / write()         → js_uart_tx     → globalThis.__mpyMachine.uartWrite
 *   UART.read()/any()               → js_uart_rx/js_uart_rx_avail（JS 侧接收队列）
 *
 * Pin 输入（pull/irq）M5 交付（02-§4 M5）；I2C/SPI/PWM/ADC 后续里程碑逐个补齐。
 * JS 侧接线见 apps/web/src/sim/mpy/engine.ts（MachineShim）。
 */

#include <string.h>
#include <emscripten.h>

#include "py/runtime.h"
#include "py/objstr.h"

// ---- JS 桥（经 globalThis.__mpyMachine 回调，由 MachineShim 注册） ----

EM_JS(void, js_gpio_write, (int pin, int level), {
    const bridge = globalThis.__mpyMachine;
    if (bridge && bridge.gpioWrite) bridge.gpioWrite(pin, level);
});

EM_JS(int, js_gpio_read, (int pin), {
    const bridge = globalThis.__mpyMachine;
    return bridge && bridge.gpioRead ? bridge.gpioRead(pin) : 0;
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
} machine_pin_obj_t;

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

static const mp_rom_map_elem_t machine_pin_locals_dict_table[] = {
    { MP_ROM_QSTR(MP_QSTR_value), MP_ROM_PTR(&machine_pin_value_obj) },
    // 常量（官方 ports/bare-arm 习惯值；IN/OUT 与 esp32 port 一致）
    { MP_ROM_QSTR(MP_QSTR_IN), MP_ROM_INT(0) },
    { MP_ROM_QSTR(MP_QSTR_OUT), MP_ROM_INT(1) },
    { MP_ROM_QSTR(MP_QSTR_PULL_NONE), MP_ROM_INT(0) },
    { MP_ROM_QSTR(MP_QSTR_PULL_UP), MP_ROM_INT(2) },
    { MP_ROM_QSTR(MP_QSTR_PULL_DOWN), MP_ROM_INT(1) },
    // IRQ 常量预留（M5 实现回调）
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
