import { z } from 'zod';
import {
  engineEventTypeSchema,
  inputEventTypeSchema,
  type EngineEventType,
  type InputEventType,
} from './engine';

/**
 * 元件/板卡定义（《03-核心模块详细设计》§2.2）
 */

export interface PinDef {
  /** 引脚名，如 "A"、"GPIO4" */
  name: string;
  /**
   * N1 修正：role 枚举统一覆盖板卡与元件用例，避免 zod 拒
   * - 板卡引脚：'power'|'gnd'|'gpio'|'i2c.sda'|'i2c.scl'|'spi.mosi'|'spi.miso'|'spi.sck'|'spi.cs'|'uart.tx'|'uart.rx'|'pwm'|'adc'
   * - 元件引脚：'power'|'gnd'|'analog'|'signal.in'|'signal.out'|'signal.io'|'passive'（role 自带方向）
   */
  role:
    | 'power'
    | 'gnd'
    | 'gpio'
    | 'i2c.sda'
    | 'i2c.scl'
    | 'spi.mosi'
    | 'spi.miso'
    | 'spi.sck'
    | 'spi.cs'
    | 'uart.tx'
    | 'uart.rx'
    | 'pwm'
    | 'adc'
    | 'analog'
    | 'signal.in'
    | 'signal.out'
    | 'signal.io'
    | 'passive';
  /** 仅板卡引脚用（'in'/'out'/'io'） */
  direction?: 'in' | 'out' | 'io';
  /** 相对元件左上角的引脚坐标（SVG 封装内，px） */
  x: number;
  y: number;
}

export interface AttrDef {
  key: string;
  type: 'enum' | 'number' | 'color' | 'boolean' | 'text';
  label: string;
  default: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface PartDefinition {
  type: string;
  name: string;
  category: 'mcu' | 'io' | 'sensor' | 'display' | 'power';
  defVersion: 1;
  pins: PinDef[];
  attrs: AttrDef[];
  /** assets/parts/<asset> */
  renderer: { asset: string; width: number; height: number };
  simulator: {
    /** 消费的引擎事件 */
    listens: EngineEventType[];
    /** 可注入的输入 */
    produces?: InputEventType[];
    /** 见《05-元件清单》行为列 */
    behavior: string;
  };
}

export interface BoardDefinition {
  type: string;
  name: string;
  mcu: 'esp32' | 'esp32s3' | 'esp32c3';
  arch: 'xtensa' | 'riscv32';
  engines: Array<'micropython-wasm' | 'qemu-remote'>;
  pins: Array<{
    name: string;
    gpio: number;
    x: number;
    y: number;
    caps: Array<
      | 'gpio'
      | 'pwm'
      | 'adc'
      | 'i2c.sda'
      | 'i2c.scl'
      | 'uart.tx'
      | 'uart.rx'
      | 'uart'
      | 'spi'
      | 'power'
      | 'gnd'
    >;
    /** 引脚所在列（05-§1.1.1：左右列同名引脚 PinRef 不带列后缀；board_pinmaps 主键 (board_type,pin_name,col)） */
    col: 'L' | 'R';
  }>;
}

// ---- zod schema ----

export const pinRoleSchema = z.enum([
  'power',
  'gnd',
  'gpio',
  'i2c.sda',
  'i2c.scl',
  'spi.mosi',
  'spi.miso',
  'spi.sck',
  'spi.cs',
  'uart.tx',
  'uart.rx',
  'pwm',
  'adc',
  'analog',
  'signal.in',
  'signal.out',
  'signal.io',
  'passive',
]);

export const pinDirectionSchema = z.enum(['in', 'out', 'io']);

export const pinDefSchema = z.object({
  name: z.string().min(1),
  role: pinRoleSchema,
  direction: pinDirectionSchema.optional(),
  x: z.number().finite(),
  y: z.number().finite(),
});

export const attrDefSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['enum', 'number', 'color', 'boolean', 'text']),
  label: z.string().min(1),
  default: z.union([z.string(), z.number(), z.boolean()]),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
});

export const partCategorySchema = z.enum(['mcu', 'io', 'sensor', 'display', 'power']);

export const partDefinitionSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  category: partCategorySchema,
  defVersion: z.literal(1),
  pins: z.array(pinDefSchema),
  attrs: z.array(attrDefSchema),
  renderer: z.object({
    asset: z.string().min(1),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  simulator: z.object({
    listens: z.array(engineEventTypeSchema),
    produces: z.array(inputEventTypeSchema).optional(),
    behavior: z.string(),
  }),
});

export const boardDefinitionSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  mcu: z.enum(['esp32', 'esp32s3', 'esp32c3']),
  arch: z.enum(['xtensa', 'riscv32']),
  engines: z.array(z.enum(['micropython-wasm', 'qemu-remote'])),
  pins: z.array(
    z.object({
      name: z.string().min(1),
      gpio: z.number().int().nonnegative(),
      x: z.number().finite(),
      y: z.number().finite(),
      caps: z.array(
        z.enum([
          'gpio',
          'pwm',
          'adc',
          'i2c.sda',
          'i2c.scl',
          'uart.tx',
          'uart.rx',
          'uart',
          'spi',
          'power',
          'gnd',
        ]),
      ),
      col: z.enum(['L', 'R']),
    }),
  ),
});
