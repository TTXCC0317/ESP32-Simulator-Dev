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
      })
      .strict()
      .refine(
        (e) => e.serialCycle !== undefined || e.serialContainsAll !== undefined,
        'expect 必须提供 serialCycle 或 serialContainsAll 至少一项',
      ),
  })
  .strict();

export type GoldenScript = z.infer<typeof goldenScriptSchema>;
export type GoldenInputEvent = z.infer<typeof goldenInputEventSchema>;

export type GoldenEngine = 'micropython-wasm' | 'qemu-remote';

export interface GoldenResult {
  engine: GoldenEngine;
  exampleId: string;
  ok: boolean;
  /** 串口采集（行数组） */
  serialLines: string[];
  /** GPIO 实际计数（expect.gpio 或 input 存在时） */
  gpio?: { pin: number; highs: number; lows: number; pwmWrites: number };
  /** 失败原因（ok=false 时） */
  error?: string;
}
