import { z } from 'zod';
import { circuitDocSchema } from './circuit';

/**
 * WS 消息信封——引擎B 链路（《03-核心模块详细设计》§2.4 + §2.5）
 *
 * schema 与类型同文件维护；类型直接由 z.infer 导出，保证与 schema 永不漂移
 * （§2.5：手写 interface 必须与 z.infer 对齐，CI 快照测试锁定 key 枚举）。
 * bytes 在 WS JSON 传输中统一为 number[]（Uint8Array 仅用于引擎内部，见 worker-protocol）。
 */

// ---- 客户端 → 服务端（§2.4 ClientMsg） ----

export const attachSchema = z.object({
  type: z.literal('attach'),
  payload: z.object({
    projectId: z.string().min(1),
    circuit: circuitDocSchema,
    firmwareId: z.string().min(1),
    boardType: z.string().min(1),
  }),
});

export const inputPinSchema = z.object({
  type: z.literal('input.pin'),
  payload: z.object({
    partId: z.string().min(1),
    pin: z.string().min(1),
    level: z.union([z.literal(0), z.literal(1)]),
    /** 按键松开（05-§1.4）：GPIO 桥解除注入，固件侧回退 pull 电平；level 被忽略 */
    release: z.boolean().optional(),
  }),
});

export const inputAnalogSchema = z.object({
  type: z.literal('input.analog'),
  payload: z.object({
    partId: z.string().min(1),
    pin: z.string().min(1),
    value: z.number().int().min(0).max(4095), // ADC 12 位
  }),
});

export const inputUartSchema = z.object({
  type: z.literal('input.uart'),
  payload: z.object({ bytes: z.array(z.number().int().min(0).max(255)) }),
});

export const ctrlSchema = z.object({
  type: z.literal('ctrl'),
  payload: z.enum(['start', 'pause', 'reset', 'stop']),
});

// ---- WS 心跳（06-§7.1.1 N20，仅引擎B链路；不计入 msg/s 速率上限） ----
// 前端 15s 发 ping；服务端立即回 pong（ts 取服务端时钟）并刷新失活判定。
// 平铺消息（无 payload 包装），归属客户端/服务端消息联合（§2.4）。

export const pingSchema = z.object({
  type: z.literal('ping'),
  ts: z.number().int().nonnegative(),
});

export const pongSchema = z.object({
  type: z.literal('pong'),
  ts: z.number().int().nonnegative(),
});

export const clientMsgSchema = z.discriminatedUnion('type', [
  attachSchema,
  inputPinSchema,
  inputAnalogSchema,
  inputUartSchema,
  ctrlSchema,
  pingSchema,
]);

export type ClientMsg = z.infer<typeof clientMsgSchema>;
export type ClientMsgType = ClientMsg['type'];

// ---- 服务端 → 客户端（§2.4 ServerMsg） ----

export const serverStateSchema = z.object({
  type: z.literal('state'),
  payload: z.object({
    status: z.enum(['attaching', 'building-wait', 'running', 'paused', 'error', 'closed']),
    error: z.string().optional(),
  }),
});

export const gpioWriteSchema = z.object({
  type: z.literal('gpio.write'),
  payload: z.object({
    pin: z.number().int().nonnegative(),
    level: z.union([z.literal(0), z.literal(1)]),
    seq: z.number().int().nonnegative(),
  }),
});

export const pwmDutySchema = z.object({
  type: z.literal('pwm.duty'),
  payload: z.object({
    pin: z.number().int().nonnegative(),
    duty: z.number(),
    freq: z.number(),
  }),
});

export const uartRxSchema = z.object({
  type: z.literal('uart.rx'),
  payload: z.object({ bytes: z.array(z.number().int().min(0).max(255)) }),
});

export const i2cTxnSchema = z.object({
  type: z.literal('i2c.txn'),
  payload: z.object({
    addr: z.number().int(),
    dir: z.enum(['r', 'w']),
    data: z.array(z.number().int().min(0).max(255)),
    seq: z.number().int().nonnegative(),
  }),
});

export const spiTxnSchema = z.object({
  type: z.literal('spi.txn'),
  payload: z.object({
    cs: z.number().int(),
    data: z.array(z.number().int().min(0).max(255)),
    seq: z.number().int().nonnegative(),
  }),
});

export const fbUpdateSchema = z.object({
  type: z.literal('fb.update'),
  payload: z.object({
    partId: z.string().min(1),
    rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    data: z.array(z.number().int().min(0).max(255)),
  }),
});

export const serverLogSchema = z.object({
  type: z.literal('log'),
  payload: z.object({ level: z.enum(['info', 'warn', 'error']), text: z.string() }),
});

/** 非法消息回执（§2.4 error.ack） */
export const errorAckSchema = z.object({
  type: z.literal('error.ack'),
  payload: z.object({ code: z.string().min(1), message: z.string() }),
});

/**
 * 编译进度推送（§7.4 N19，复用引擎B WS 会话通道）：
 * 普通行 100ms 窗口聚合为 logLines 批量；critical 行（error/warning）以 logLine 立即推送不聚合。
 * 引擎A 不出现此消息（无后端编译）。
 */
export const buildProgressSchema = z.object({
  type: z.literal('build.progress'),
  payload: z.object({
    buildId: z.string().min(1),
    phase: z.enum(['queued', 'compiling', 'linking', 'merging', 'success', 'failed']),
    /** 0..1，按 arduino-cli 输出行数估算 */
    progress: z.number().min(0).max(1),
    /** critical 单行（error/warning），立即推送 */
    logLine: z.string().optional(),
    /** 100ms 窗口聚合的普通行批量 */
    logLines: z.array(z.string()).optional(),
    /** failed 时的错误摘要 */
    error: z.string().optional(),
  }),
});

export const serverMsgSchema = z.discriminatedUnion('type', [
  serverStateSchema,
  gpioWriteSchema,
  pwmDutySchema,
  uartRxSchema,
  i2cTxnSchema,
  spiTxnSchema,
  fbUpdateSchema,
  serverLogSchema,
  errorAckSchema,
  buildProgressSchema,
  pongSchema,
]);

export type ServerMsg = z.infer<typeof serverMsgSchema>;
export type ServerMsgType = ServerMsg['type'];
