import { z } from 'zod';

/**
 * Golden 剧本 schema（02-§3.2 L5）：
 * 每个示例工程附 golden.json（输入序列 + 预期 GPIO 事件 + 预期串口输出；
 * OLED 帧哈希随 M9 启用）。容差：时间 ±100ms（M9 帧比对用），M4 v1 为串口行序列断言。
 *
 * 引擎支持度（02-§4 节奏原则："引擎B 按其实际支持度标注例外"）：
 * - serialCycle：两引擎断言（blink 的 Serial.println 经 uart 通道）；
 * - gpio：两引擎断言（引擎A machine shim 计数；引擎B M5 GPIO 桥 GPIO_WRITE 帧计数）；
 * - input：两引擎注入（M5：GPIO 层输入序列，atMs 相对运行窗口起点）。
 */

/** 输入注入事件（02-§3.2 输入序列）：GPIO 层直注，双引擎注入 API 均以 GPIO 编号为键 */
export const goldenInputEventSchema = z.object({
  /** 相对运行窗口起点（固件开始执行）的注入时刻（ms）；应小于 durationMs */
  atMs: z.number().int().min(0),
  /** 目标板卡 GPIO 编号 */
  gpio: z.number().int().nonnegative(),
  /** 注入电平（release=true 时忽略，回退固件 pull 语义，05-§1.4） */
  level: z.union([z.literal(0), z.literal(1)]),
  /** 释放：清除注入，回退 pull 电平（引擎A gpioConfigure / 引擎B PIN_MODE 帧记录） */
  release: z.boolean().optional(),
});

/** M8：expect.i2c 断言——期望的 I2C 事务序列（引擎B 从 TLV 帧收；引擎A shim 未实现则 skip） */
export const goldenI2cExpectSchema = z.object({
  addr: z.number().int().min(0).max(0x7f),
  dir: z.enum(['w', 'r']),
  /** w 事务：写入字节序列（Wire.write 内容）；r 事务不填（长度由寄存器表决定） */
  data: z.array(z.number().int().min(0).max(0xff)).optional(),
});

/**
 * M8 后续：expect.sensor 断言——期望的环境传感器读数（DHT22 等 env-sensor）
 * tolerance: 允许误差（默认 0.1；DHT22 ±0.5℃ / ±2%RH，取 0.5）
 * 注：sensor.data 从 ws-gateway sensor.data 事件收集，匹配逻辑用 Record<string,number>
 */
export const goldenSensorExpectSchema = z.object({
  /** circuit 中 env-sensor part 的 id（定位设备） */
  partId: z.string().min(1),
  /** 期望读数 key→value：{ temperature: 22, humidity: 50 } */
  data: z.record(z.number()),
  /** 绝对误差容限（默认 0.5） */
  tolerance: z.number().min(0).optional(),
});

/**
 * M9：expect.fb 断言——SSD1306 全帧哈希（引擎B FB_TXN 增量段重组后取 sha256；
 * 引擎A wasm shim 未实现 framebuffer → skip）。
 * 哈希对象：128×64 单色位图 1024B，页主序 fb[page*128+col]，每字节 8 个垂直像素 LSB=上。
 */
export const goldenFbExpectSchema = z.object({
  /** circuit 中 oled-device part 的 id（定位设备） */
  partId: z.string().min(1),
  /** 全帧 sha256 hex（1024B，小写） */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * M9：expect.neopixel 断言——WS2812 写入计数 + 最后帧哈希
 *（NEOPIXEL_WRITE 帧 GRB→RGB 归一后 sha256；引擎A RMT shim 未实现 → skip）。
 */
export const goldenNeopixelExpectSchema = z.object({
  /** circuit 中 neopixel-device part 的 id（定位设备） */
  partId: z.string().min(1),
  /** 窗口内 neopixel.write 最少次数（rainbow 等连续动画 ≥2） */
  minWrites: z.number().int().positive().optional(),
  /** 最后一次写入的 RGB 字节序列 sha256 hex（3×N，小写） */
  lastHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const goldenScriptSchema = z
  .object({
    exampleId: z.string().min(1),
    /** 串口采集时长（ms）；引擎A 为运行时长 */
    durationMs: z.number().int().min(1000).max(60_000),
    /** 输入注入序列（M5；按 atMs 调度，双引擎同源） */
    input: z.array(goldenInputEventSchema).optional(),
    expect: z
      .object({
        /** 串口行按此序列循环输出，采集窗口内完整循环 ≥2 轮；与 serialContainsAll 二选一（或都给） */
        serialCycle: z.array(z.string()).min(1).optional(),
        /** 串口行中必须全部出现过的子串列表（每行独立 include 判断）；与 serialCycle 二选一（或都给） */
        serialContainsAll: z.array(z.string()).min(1).optional(),
        /** GPIO 电平/PWM 断言（两引擎：置高/置低次数、PWM duty 事件计数） */
        gpio: z
          .object({
            pin: z.number().int().nonnegative(),
            /** 置高次数（≥2：blink 至少两轮闪烁） */
            highs: z.number().int().positive().optional(),
            /** 置低次数 */
            lows: z.number().int().positive().optional(),
            /** PWM duty 写入事件最少次数（M7 pwm-breath 断言：duty 更新回调 ≥N 次） */
            minPwm: z.number().int().nonnegative().optional(),
          })
          .strict()
          .refine(
            (g) => g.highs !== undefined || g.lows !== undefined || g.minPwm !== undefined,
            'gpio 断言至少需要 highs/lows/minPwm 中的一个字段',
          )
          .optional(),
        /** M8：I2C 事务序列断言（前缀匹配——durationMs 窗口内收集到的事务应至少覆盖此序列） */
        i2c: z.array(goldenI2cExpectSchema).optional(),
        /** M8 后续：环境传感器读数断言（收集 sensor.data 事件，匹配 partId + 数值容限） */
        sensor: z.array(goldenSensorExpectSchema).optional(),
        /** M9：SSD1306 全帧哈希断言（引擎B FB_TXN 重组；引擎A skip） */
        fb: z.array(goldenFbExpectSchema).optional(),
        /** M9：NeoPixel 写入计数/最后帧哈希断言（引擎B；引擎A skip） */
        neopixel: z.array(goldenNeopixelExpectSchema).optional(),
      })
      .strict()
      .refine(
        (e) =>
          e.serialCycle !== undefined ||
          e.serialContainsAll !== undefined ||
          e.gpio !== undefined ||
          e.i2c !== undefined ||
          e.sensor !== undefined ||
          e.fb !== undefined ||
          e.neopixel !== undefined,
        'expect 必须提供 serialCycle/serialContainsAll/gpio/i2c/sensor/fb/neopixel 至少一项',
      ),
  })
  .strict();

export type GoldenScript = z.infer<typeof goldenScriptSchema>;
export type GoldenInputEvent = z.infer<typeof goldenInputEventSchema>;

export type GoldenEngine = 'micropython-wasm' | 'qemu-remote';

export interface GoldenI2cTxn {
  addr: number;
  dir: 'w' | 'r';
  data: number[];
}

export interface GoldenResult {
  engine: GoldenEngine;
  exampleId: string;
  ok: boolean;
  /** 串口采集（行数组） */
  serialLines: string[];
  /** GPIO 实际计数（expect.gpio 或 input 存在时） */
  gpio?: { pin: number; highs: number; lows: number; pwmWrites: number };
  /** M8：收集到的 I2C 事务序列（expect.i2c 断言用；引擎A shim 未实现则空数组） */
  i2cTxns?: GoldenI2cTxn[];
  /** M8 后续：收集到的 sensor.data 事件（expect.sensor 断言用） */
  sensorActual?: { partId: string; data: Record<string, number>; gpio: number }[];
  /** M9：SSD1306 全帧 sha256（引擎B FB_TXN 重组结果；引擎A 空） */
  fbActual?: { partId: string; hash: string }[];
  /** M9：NeoPixel 写入计数 + 最后帧 sha256（引擎B；引擎A 空） */
  neopixelActual?: { partId: string; writes: number; lastHash: string }[];
  /** 失败原因（ok=false 时） */
  error?: string;
}
