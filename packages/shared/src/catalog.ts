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

/**
 * I2C/SPI 设备寄存器语义（M8 D3，03-§2.2）。
 * 双端（引擎A PinBus / 引擎B gpioBridge）共同解释此声明应答 I2C/SPI 事务，
 * 避免行为漂移；无设备挂载的 addr/cs 宿主回 NACK 语义（len=0）。
 */
export interface I2cRegisterSpec {
  /** 寄存器/命令字节（0x00–0xFF）；7-bit 地址限制在 I2cDeviceSpec.address */
  addr: number;
  /** 单次读取字节数（如 BH1750 high-res=2, MPU6050 加速度 6 轴=6） */
  size: number;
  /** 返回字节解码语义（默认 'raw' 透传） */
  decode?: 'raw' | 'lux' | 'be.int16' | 'le.uint16' | 'accel.xyz' | 'gyro.xyz' | 'whoami';
  /** 无注入时的默认字节（按 size 填充；不填则按 decode 语义生成 0 值） */
  defaultBytes?: number[];
}

export interface I2cDeviceSpec {
  kind: 'i2c-device';
  /** 7-bit I2C 地址（BH1750=0x23, MPU6050=0x68） */
  address: number;
  /** 寄存器语义表 */
  registers: I2cRegisterSpec[];
}

export interface SpiDeviceSpec {
  kind: 'spi-device';
  /** CS 片选对应的板卡 GPIO（绑定 spi.txn.cs） */
  csGpio: number;
  /** 命令字 + 返回字节语义（addr=命令字，size=返回字节长度） */
  registers?: I2cRegisterSpec[];
}

/**
 * M8 后续：环境传感器设备语义（DHT22、AHT20 等单总线/非标准协议传感器）
 * 注：pinGpio 由 ws-gateway buildDeviceTables 运行时从 circuit connections 解析
 * （definition_json 不固定引脚，因为传感器可接任意 GPIO）
 */
export interface DhtDeviceSpec {
  kind: 'env-sensor';
  /** attrs 默认值（Inspector 滑杆可注入覆盖；默认 temp=22, humidity=50） */
  defaults: { temperature: number; humidity: number };
}

/**
 * M9：SSD1306 OLED 设备语义（behavior='oled-128x64'）。
 * 固件 I2C 写（0x3C/0x3D）由 glue 协议级拦截维护 framebuffer，经 FB_TXN 帧上报；
 * 宿主按 address 路由 partId → fb.update 推送前端渲染。
 */
export interface OledDeviceSpec {
  kind: 'oled-device';
  /** 7-bit I2C 地址（默认 0x3C=60；attrs.i2cAddr 可覆盖） */
  address: number;
}

/**
 * M9：NeoPixel WS2812 灯带设备语义（behavior='neopixel'）。
 * pinGpio 由 ws-gateway buildDeviceTables 运行时从 role='signal.io'（DIN）连接解析；
 * 灯珠数以 part.attrs.pixels 为准（defaults 仅缺省兜底）。
 */
export interface NeopixelDeviceSpec {
  kind: 'neopixel-device';
  defaults?: { pixels?: number; brightness?: number };
}

export type DeviceSpec =
  I2cDeviceSpec | SpiDeviceSpec | DhtDeviceSpec | OledDeviceSpec | NeopixelDeviceSpec;

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
    /** 见《05-元件清单》行为列；'i2c-device'/'spi-device' 触发查 device 字段 */
    behavior: string;
    /** M8：I2C/SPI 设备语义表（behavior='i2c-device'/'spi-device' 时必填） */
    device?: DeviceSpec;
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

export const i2cRegisterSpecSchema = z.object({
  addr: z.number().int().min(0).max(0xff),
  size: z.number().int().min(0).max(255),
  decode: z
    .enum(['raw', 'lux', 'be.int16', 'le.uint16', 'accel.xyz', 'gyro.xyz', 'whoami'])
    .optional(),
  defaultBytes: z.array(z.number().int().min(0).max(255)).optional(),
});

export const i2cDeviceSpecSchema = z.object({
  kind: z.literal('i2c-device'),
  address: z.number().int().min(0).max(0x7f),
  registers: z.array(i2cRegisterSpecSchema),
});

export const spiDeviceSpecSchema = z.object({
  kind: z.literal('spi-device'),
  csGpio: z.number().int().nonnegative(),
  registers: z.array(i2cRegisterSpecSchema).optional(),
});

export const dhtDeviceSpecSchema = z.object({
  kind: z.literal('env-sensor'),
  defaults: z.object({
    temperature: z.number(),
    humidity: z.number(),
  }),
});

export const oledDeviceSpecSchema = z.object({
  kind: z.literal('oled-device'),
  address: z.number().int().min(0).max(0x7f),
});

export const neopixelDeviceSpecSchema = z.object({
  kind: z.literal('neopixel-device'),
  defaults: z
    .object({
      pixels: z.number().int().min(1).max(84).optional(),
      brightness: z.number().int().min(0).max(255).optional(),
    })
    .optional(),
});

export const deviceSpecSchema = z.discriminatedUnion('kind', [
  i2cDeviceSpecSchema,
  spiDeviceSpecSchema,
  dhtDeviceSpecSchema,
  oledDeviceSpecSchema,
  neopixelDeviceSpecSchema,
]);

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
    device: deviceSpecSchema.optional(),
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
