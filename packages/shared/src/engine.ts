import { z } from 'zod';
import type { CircuitDoc } from './circuit';
import type { PartId } from './circuit';

/**
 * 引擎抽象（《03-核心模块详细设计》§2.3）
 */

export type EngineEventType =
  'gpio.write' | 'pwm.duty' | 'uart.rx' | 'i2c.txn' | 'spi.txn' | 'fb.update' | 'log' | 'state';

export type InputEventType = 'pin.level' | 'analog.value' | 'sensor.data' | 'uart.tx' | 'key.event';

export const engineEventTypeSchema = z.enum([
  'gpio.write',
  'pwm.duty',
  'uart.rx',
  'i2c.txn',
  'spi.txn',
  'fb.update',
  'log',
  'state',
]);

/** 'key.event' 为预留类型，InputEvent 暂无对应成员（§2.3） */
export const inputEventTypeSchema = z.enum([
  'pin.level',
  'analog.value',
  'sensor.data',
  'uart.tx',
  'key.event',
]);

export type EngineStatus = 'idle' | 'loading' | 'running' | 'paused' | 'error';

export interface EngineEventMap {
  'gpio.write': { pin: number; level: 0 | 1; seq: number };
  'pwm.duty': { pin: number; duty: number; freq: number };
  'uart.rx': { bytes: Uint8Array; port: 0 | 1 | 2 };
  'i2c.txn': { addr: number; dir: 'r' | 'w'; data: Uint8Array; seq: number };
  'spi.txn': { cs: number; data: Uint8Array; seq: number };
  'fb.update': { partId: PartId; rect: [number, number, number, number]; data: Uint8Array };
  log: { level: 'info' | 'warn' | 'error'; text: string };
  state: { status: EngineStatus; error?: string };
}

export interface FirmwareSourceFiles {
  kind: 'sources';
  files: Array<{ path: string; content: string }>;
}

/** 引擎B经后端；entry=app 分区偏移（默认 0x10000） */
export interface FirmwareBinary {
  kind: 'binary';
  flashImg: Uint8Array;
  entry?: number;
}

export type FirmwareInput = FirmwareSourceFiles | FirmwareBinary;

export type InputEvent =
  | {
      type: 'pin.level';
      partId: PartId;
      pin: string;
      level: 0 | 1;
      /** 按键松开（05-§1.4）：忽略 level，引擎侧解除注入并回退 pull 电平 */
      release?: boolean;
    }
  | { type: 'analog.value'; partId: PartId; pin: string; value: number } // 0..4095
  | { type: 'sensor.data'; partId: PartId; data: Record<string, number> } // {temp: 25.5, hum: 60}
  | { type: 'uart.tx'; bytes: Uint8Array; port?: 0 | 1 | 2 };

/**
 * 引擎统一抽象（§3.2）。引擎A 接 sources（N3）；引擎B 接 binary（BuildService 预编译后传入）。
 */
export interface SimulationEngine {
  readonly kind: 'micropython-wasm' | 'qemu-remote';
  load(circuit: CircuitDoc, fw: FirmwareInput): Promise<void>;
  start(opts?: { speed?: 0.25 | 0.5 | 1 | 2 | 4 }): void;
  pause(): void;
  reset(): void;
  dispose(): void;
  on<K extends EngineEventType>(type: K, cb: (p: EngineEventMap[K]) => void): () => void;
  input(ev: InputEvent): void;
}

// ---- N2: 三套状态枚举映射（EngineStatus / ServerMsg.state / simStore.status） ----
// ┌─────────────┬──────────────────┬──────────────────────────────┐
// │ EngineStatus │ ServerMsg.state  │ simStore.status              │
// ├─────────────┼──────────────────┼──────────────────────────────┤
// │ idle        │ (无 WS，未 attach)│ 'idle'                       │
// │ loading     │ 'attaching'      │ 'loading'                    │
// │ (无)        │ 'building-wait'  │ 'building'（引擎B编译等待）   │
// │ running     │ 'running'        │ 'running'                    │
// │ paused      │ 'paused'         │ 'paused'                     │
// │ error       │ 'error'          │ 'error'                      │
// │ (无)        │ 'closed'         │ 'idle'（会话已关闭，回空闲）  │
// └─────────────┴──────────────────┴──────────────────────────────┘
// 引擎A 不出现 'building-wait'/'closed'；引擎B 不出现 'loading'；
// simStore 暴露给 UI 的状态码：'idle'|'loading'|'building'|'running'|'paused'|'error'。

// ---- zod schema ----

export const engineStatusSchema = z.enum(['idle', 'loading', 'running', 'paused', 'error']);

export const firmwareInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sources'),
    files: z.array(z.object({ path: z.string().min(1), content: z.string() })),
  }),
  z.object({
    kind: z.literal('binary'),
    flashImg: z.instanceof(Uint8Array),
    entry: z.number().int().nonnegative().optional(),
  }),
]);

export const inputEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pin.level'),
    partId: z.string().min(1),
    pin: z.string().min(1),
    level: z.union([z.literal(0), z.literal(1)]),
    release: z.boolean().optional(), // 按键松开：level 被忽略
  }),
  z.object({
    type: z.literal('analog.value'),
    partId: z.string().min(1),
    pin: z.string().min(1),
    value: z.number().int().min(0).max(4095), // ADC 12 位
  }),
  z.object({
    type: z.literal('sensor.data'),
    partId: z.string().min(1),
    data: z.record(z.string(), z.number()),
  }),
  z.object({
    type: z.literal('uart.tx'),
    bytes: z.instanceof(Uint8Array),
    port: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  }),
]);
