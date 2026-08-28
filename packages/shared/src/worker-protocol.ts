import { z } from 'zod';
import { firmwareInputSchema } from './engine';
import type { EngineStatus, InputEvent, FirmwareInput } from './engine';
import type { EngineEventMap } from './engine';
import type { CircuitDoc } from './circuit';

/**
 * 引擎A Worker 消息协议（《03-核心模块详细设计》§2.6 / N7）
 *
 * 主线程 ⇄ Worker 纯 postMessage（N22 决策：不依赖 SharedArrayBuffer/COOP/COEP）；
 * Uint8Array 经结构化克隆天然支持，不需要 base64 转换。
 */

// ---- WorkerMsg（主线程 → Worker） ----

export type WorkerMsg =
  | { type: 'load'; payload: { circuit: CircuitDoc; fw: FirmwareInput } }
  | { type: 'start'; payload: { speed?: 0.25 | 0.5 | 1 | 2 | 4 } }
  | { type: 'pause' }
  | { type: 'reset' }
  | { type: 'input'; payload: InputEvent }
  | { type: 'dispose' };

// ---- WorkerReply（Worker → 主线程） ----

/** 引擎事件统一 envelope（16ms 批量聚合随 event.batch 下发） */
export type EngineEvent = {
  [K in keyof EngineEventMap]: { kind: K } & EngineEventMap[K];
}[keyof EngineEventMap];

export type WorkerReply =
  | { type: 'ready'; payload: { wasmMemBytes: number } }
  | { type: 'event.batch'; payload: { events: EngineEvent[] } }
  | { type: 'state'; payload: { status: EngineStatus; error?: string } }
  | { type: 'log'; payload: { level: 'info' | 'warn' | 'error'; text: string } };

// ---- zod schema ----
// 校验策略（§2.6）：Worker 内 self.onmessage 入口先 workerMsgSchema.safeParse，
// 失败 postMessage log.error 并跳过；不引入 error.ack（仅 WS 协议有）。

export const workerMsgSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('load'),
    payload: z.object({
      circuit: z.unknown(), // CircuitDoc schema 见 circuit.ts，转交校验
      fw: firmwareInputSchema,
    }),
  }),
  z.object({
    type: z.literal('start'),
    payload: z.object({
      speed: z
        .union([z.literal(0.25), z.literal(0.5), z.literal(1), z.literal(2), z.literal(4)])
        .optional(),
    }),
  }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('reset') }),
  z.object({ type: z.literal('input'), payload: z.unknown() }), // InputEvent schema 见 engine.ts
  z.object({ type: z.literal('dispose') }),
]);
