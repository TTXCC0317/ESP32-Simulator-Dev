import { z } from 'zod';

/**
 * 电路文档模型（《03-核心模块详细设计》§2.1）
 *
 * 类型与 zod schema 同文件维护（§2.5 约定：schema 与类型单一来源）。
 */

/** 元件实例 ID（nanoid，如 "p_7f3k..."） */
export type PartId = string;

/** 引脚引用："${PartId}:${pinName}"，如 "esp:GPIO4"；板卡左右列同名引脚不带列后缀（05-§1.1.1） */
export type PinRef = `${PartId}:${string}`;

export type WireColor =
  'black' | 'red' | 'green' | 'blue' | 'yellow' | 'orange' | 'purple' | 'gray';

/** Wokwi 布线语义：v/h 正交段，'*' 表示交由自动正交布线 */
export interface WireSegment {
  dir: 'v' | 'h' | '*';
  len: number;
}

export interface PartInstance {
  id: PartId;
  /** 元件类型，如 "wokwi-led" */
  type: string;
  /** 画布坐标（px，网格 20px） */
  left: number;
  top: number;
  rotate: 0 | 90 | 180 | 270;
  attrs: Record<string, string | number | boolean>;
  hide?: boolean;
}

export interface Connection {
  id: string;
  source: PinRef;
  target: PinRef;
  color: WireColor;
  /** 空数组 = 自动正交布线 */
  path: WireSegment[];
}

export interface CircuitDoc {
  formatVersion: 1;
  /** 板卡 type，带 board- 前缀（01-§7.4.1 N4），如 "board-esp32-devkit-c-v4"；与 parts[0].type 一致 */
  boardType: string;
  parts: PartInstance[];
  connections: Connection[];
  serialMonitor: { baudrate: number };
}

/** 校验结果（M2 diagram 双向同步使用） */
export interface CircuitValidation {
  ok: boolean;
  errors: Array<{
    code:
      | 'BAD_JSON'
      | 'DUP_PART_ID'
      | 'BAD_PINREF'
      | 'OVER_LIMIT'
      | 'UNKNOWN_TYPE'
      | 'I2C_ADDR_CONFLICT'
      | 'SPI_CS_CONFLICT';
    message: string;
    path?: string;
  }>;
}

// ---- zod schema ----

export const wireColorSchema = z.enum([
  'black',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'gray',
]);

export const wireSegmentSchema = z.object({
  dir: z.enum(['v', 'h', '*']),
  len: z.number().int(),
});

export const partInstanceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  left: z.number().finite(),
  top: z.number().finite(),
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  hide: z.boolean().optional(),
});

/**
 * 连线 schema：source/target 按 `partId:pin` 字符串校验；
 * 输出类型断言为 Connection（PinRef 模板字面量）——zod v3 无法直接推断模板字面量，
 * 业务侧由 parsePinRef/validateCircuitDoc 兜底（§2.5）。
 */
export const connectionSchema = z.object({
  id: z.string().min(1),
  /** PinRef = `${PartId}:${pin}` */
  source: z.string().min(1),
  target: z.string().min(1),
  color: wireColorSchema,
  path: z.array(wireSegmentSchema),
}) as unknown as z.ZodType<Connection, z.ZodTypeDef, unknown>;

export const circuitDocSchema = z.object({
  formatVersion: z.literal(1),
  boardType: z.string().min(1),
  parts: z.array(partInstanceSchema),
  connections: z.array(connectionSchema),
  serialMonitor: z.object({ baudrate: z.number().int().positive() }),
});
