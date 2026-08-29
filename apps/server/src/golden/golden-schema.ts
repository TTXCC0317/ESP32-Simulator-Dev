import { z } from 'zod';

/**
 * Golden 剧本 schema（02-§3.2 L5）：
 * 每个示例工程附 golden.json（输入序列 + 预期 GPIO 事件 + 预期串口输出；
 * OLED 帧哈希随 M9 启用）。容差：时间 ±100ms（M9 帧比对用），M4 v1 为串口行序列断言。
 *
 * M4 引擎支持度（02-§4 节奏原则："引擎B 按其实际支持度标注例外"）：
 * - serialCycle：两引擎断言（blink 的 Serial.println 经 uart 通道）；
 * - gpio：引擎A 断言（PinBus 电平翻转计数）；引擎B GPIO 桥随 M5，缺失时 qemu 引擎跳过。
 */

export const goldenScriptSchema = z.object({
  exampleId: z.string().min(1),
  /** 串口采集时长（ms）；引擎A 为运行时长 */
  durationMs: z.number().int().min(1000).max(60_000),
  expect: z.object({
    /** 串口行按此序列循环输出，采集窗口内完整循环 ≥2 轮 */
    serialCycle: z.array(z.string()).min(1),
    /** GPIO 电平断言（引擎A；引擎B M5 起启用） */
    gpio: z
      .object({
        pin: z.number().int().nonnegative(),
        /** 置高次数（≥2：blink 至少两轮闪烁） */
        highs: z.number().int().positive(),
        /** 置低次数 */
        lows: z.number().int().positive(),
      })
      .optional(),
  }),
});

export type GoldenScript = z.infer<typeof goldenScriptSchema>;

export type GoldenEngine = 'micropython-wasm' | 'qemu-remote';

export interface GoldenResult {
  engine: GoldenEngine;
  exampleId: string;
  ok: boolean;
  /** 串口采集（行数组） */
  serialLines: string[];
  /** 失败原因（ok=false 时） */
  error?: string;
}
