import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfigSchema } from '../config/schema';
import { openDatabase } from '../db/client';
import { runMigrations } from '../db/migrator';
import { MODE_INPUT, MODE_PULLUP } from '../services/gpio.bridge';
import {
  assertI2cPrefix,
  assertSerialCycle,
  runGoldenEngineA,
  runGoldenEngineB,
  loadGoldenScript,
  type GoldenGpioChannel,
} from './runner';
import { goldenInputEventSchema } from './golden-schema';
import type { GoldenScript } from './golden-schema';

/**
 * L1（02-§4 M4）：Golden 运行器 v1——剧本加载/串口断言/引擎B 全流程（stub 工具链）。
 * 真实 arduino-cli + QEMU 的 L5 在工具链实装后由 `pnpm golden` 验证。
 */

function baseScript(over?: Partial<GoldenScript>): GoldenScript {
  return {
    exampleId: 'blink',
    durationMs: 1100,
    expect: { serialCycle: ['LED ON', 'LED OFF'] },
    ...over,
  };
}

function setupDb() {
  const db = openDatabase({ path: ':memory:', wal: false });
  runMigrations(db);
  return db;
}

describe('assertSerialCycle（串口循环断言）', () => {
  it('完整 2 轮通过；夹带启动日志行不影响', () => {
    const lines = ['rst:0x1 (POWERON)', 'LED ON', 'LED OFF', 'LED ON', 'LED OFF'];
    expect(assertSerialCycle(lines, ['LED ON', 'LED OFF'], 2)).toBe(true);
  });

  it('1 轮不达标；乱序不计轮', () => {
    expect(assertSerialCycle(['LED ON', 'LED OFF'], ['LED ON', 'LED OFF'], 2)).toBe(false);
    expect(
      assertSerialCycle(['LED OFF', 'LED ON', 'LED OFF', 'LED ON'], ['LED ON', 'LED OFF'], 2),
    ).toBe(false);
  });
});

/** M8：I2C 事务序列断言纯函数测试（前缀匹配） */
describe('assertI2cPrefix（I2C 事务前缀匹配）', () => {
  it('空 expect → true', () => {
    expect(assertI2cPrefix([], [])).toBe(true);
    expect(assertI2cPrefix([{ addr: 0x23, dir: 'r', data: [] }], [])).toBe(true);
  });

  it('完全相等序列 → true', () => {
    const txns = [
      { addr: 0x23, dir: 'w' as const, data: [0x10] },
      { addr: 0x23, dir: 'r' as const, data: [0, 120] },
    ];
    const exp = [
      { addr: 0x23, dir: 'w' as const, data: [0x10] },
      { addr: 0x23, dir: 'r' as const },
    ];
    expect(assertI2cPrefix(txns, exp)).toBe(true);
  });

  it('expect 是前缀 → true（收集到更多事务）', () => {
    const txns = [
      { addr: 0x23, dir: 'w' as const, data: [0x10] },
      { addr: 0x23, dir: 'r' as const, data: [0, 120] },
      { addr: 0x23, dir: 'w' as const, data: [0x10] },
      { addr: 0x23, dir: 'r' as const, data: [0, 120] },
    ];
    const exp = [
      { addr: 0x23, dir: 'w' as const, data: [0x10] },
      { addr: 0x23, dir: 'r' as const },
    ];
    expect(assertI2cPrefix(txns, exp)).toBe(true);
  });

  it('收集不足 → false', () => {
    expect(
      assertI2cPrefix(
        [{ addr: 0x23, dir: 'w', data: [0x10] }],
        [
          { addr: 0x23, dir: 'w', data: [0x10] },
          { addr: 0x23, dir: 'r' },
        ],
      ),
    ).toBe(false);
  });

  it('addr 不匹配 → false', () => {
    expect(
      assertI2cPrefix(
        [{ addr: 0x24, dir: 'w', data: [0x10] }],
        [{ addr: 0x23, dir: 'w', data: [0x10] }],
      ),
    ).toBe(false);
  });

  it('dir 不匹配 → false', () => {
    expect(
      assertI2cPrefix(
        [{ addr: 0x23, dir: 'r', data: [0x10] }],
        [{ addr: 0x23, dir: 'w', data: [0x10] }],
      ),
    ).toBe(false);
  });

  it('w 事务 data 不匹配 → false', () => {
    expect(
      assertI2cPrefix(
        [{ addr: 0x23, dir: 'w', data: [0x11] }],
        [{ addr: 0x23, dir: 'w', data: [0x10] }],
      ),
    ).toBe(false);
  });

  it('r 事务 expect.data 可省略', () => {
    expect(
      assertI2cPrefix([{ addr: 0x23, dir: 'r', data: [0, 120] }], [{ addr: 0x23, dir: 'r' }]),
    ).toBe(true);
  });
});

describe('runGoldenEngineB（引擎B 全流程，stub 工具链）', () => {
  it('编译成功 + 串口循环 ≥2 轮 → ok', async () => {
    const db = setupDb();
    const dir = mkdtempSync(join(tmpdir(), 'golden-'));
    const config = appConfigSchema.parse({
      builds: { dir: join(dir, 'builds') },
      flash: { dir: join(dir, 'flash') },
      tools: { qemuXtensa: 'qemu-fake', qemuRiscv32: 'qemu-fake' },
    });

    const result = await runGoldenEngineB(baseScript(), {
      db,
      config,
      buildRunner: async (file, args, opts) => {
        if (file.includes('arduino-cli')) {
          opts.onLine('Compiling blink.ino');
          return { exitCode: 0 };
        }
        // esptool merge_bin：产出 flash.img
        const oi = args.indexOf('-o');
        writeFileSync(args[oi + 1] ?? '', Buffer.alloc(1024));
        return { exitCode: 0 };
      },
      serialCollector: async (onLine, durationMs) => {
        onLine('LED ON');
        onLine('LED OFF');
        await new Promise<void>((res) => {
          setTimeout(
            () => {
              onLine('LED ON');
              onLine('LED OFF');
              res();
            },
            Math.min(50, durationMs / 2),
          );
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });

  it('编译失败 → ok=false + 错误摘要', async () => {
    const db = setupDb();
    const config = appConfigSchema.parse({});
    const result = await runGoldenEngineB(baseScript(), {
      db,
      config,
      buildRunner: async () => {
        throw new Error('sketch error');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('编译未成功');
  });

  it('串口输出不满足 2 轮 → ok=false', async () => {
    const db = setupDb();
    const dir = mkdtempSync(join(tmpdir(), 'golden-'));
    const config = appConfigSchema.parse({
      builds: { dir: join(dir, 'builds') },
      flash: { dir: join(dir, 'flash') },
      tools: { qemuXtensa: 'qemu-fake', qemuRiscv32: 'qemu-fake' },
    });
    const result = await runGoldenEngineB(baseScript(), {
      db,
      config,
      buildRunner: async (_f, _a, opts) => {
        opts.onLine('ok');
        return { exitCode: 0 };
      },
      serialCollector: async (onLine) => {
        onLine('LED ON');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('完整 2 轮');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('golden 剧本', () => {
  it('examples/blink/golden.json 可加载且 schema 字段齐全', () => {
    const s = loadGoldenScript('blink');
    expect(s.exampleId).toBe('blink');
    expect(s.expect.serialCycle).toEqual(['LED ON', 'LED OFF']);
    expect(s.expect.gpio).toMatchObject({ pin: 4 });
  });

  it('examples/button-led/golden.json：输入序列 + GPIO 断言字段齐全（M5）', () => {
    const s = loadGoldenScript('button-led');
    expect(s.exampleId).toBe('button-led');
    expect(s.input).toHaveLength(4);
    expect(s.input?.[0]).toMatchObject({ atMs: 2000, gpio: 4, level: 0 });
    expect(s.input?.[1]).toMatchObject({ gpio: 4, release: true });
    expect(s.expect.serialCycle).toEqual(['LED ON', 'LED OFF']);
    expect(s.expect.gpio).toMatchObject({ pin: 2, highs: 2, lows: 2 });
  });

  it('input 事件 schema：atMs/gpio/level 解析；非法 level/atMs 拒绝', () => {
    expect(
      goldenInputEventSchema.parse({ atMs: 2000, gpio: 4, level: 0, release: true }),
    ).toMatchObject({ gpio: 4, release: true });
    expect(goldenInputEventSchema.safeParse({ atMs: 0, gpio: 2, level: 2 }).success).toBe(false);
    expect(goldenInputEventSchema.safeParse({ atMs: -1, gpio: 2, level: 0 }).success).toBe(false);
  });

  it('引擎A：产物未入库 → 引导性失败（mpyDir 指向空目录即复现）', async () => {
    const db = setupDb();
    const r = await runGoldenEngineA(baseScript(), {
      db,
      mpyDir: join(tmpdir(), `golden-a-missing-${Date.now()}`),
    });
    // 产物缺失：返回 skip 引导而非崩溃（CI 环境无 wasm 产物同样命中）
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/wasm 产物未入库|联调/i);
  });

  it('M8 i2c-sensor golden.json 可加载（serialContainsAll 断言 BH1750 读数）', () => {
    const s = loadGoldenScript('i2c-sensor');
    expect(s.exampleId).toBe('i2c-sensor');
    expect(s.expect.serialContainsAll).toContain('LUX: 100');
  });

  it('M8 mpu6050-roll golden.json 可加载（WHO_AM_I + ACCEL 断言）', () => {
    const s = loadGoldenScript('mpu6050-roll');
    expect(s.exampleId).toBe('mpu6050-roll');
    expect(s.expect.serialContainsAll).toEqual(['WHO_AM_I: 0x68', 'ACCEL']);
  });

  it('M8 dht22-basic golden.json 可加载（TEMP/HUM 断言）', () => {
    const s = loadGoldenScript('dht22-basic');
    expect(s.exampleId).toBe('dht22-basic');
    expect(s.expect.serialContainsAll).toEqual(['TEMP: 22.0', 'HUM: 50.0']);
  });
});

/**
 * 伪固件 GPIO 桥（stub channel）：注册时上报 PIN_MODE(4, INPUT_PULLUP)（模拟
 * setup() 的 pinMode），按键 GPIO4 注入反应为 LED GPIO2 写出（按下置高/释放置低）。
 */
function fakeFirmwareChannel(injected: Array<{ pin: number; level: 0 | 1 }>): GoldenGpioChannel {
  let onWrite: ((pin: number, level: 0 | 1) => void) | null = null;
  return {
    onGpioWrite(cb) {
      onWrite = cb;
    },
    onPinMode(cb) {
      cb(4, MODE_INPUT | MODE_PULLUP);
    },
    injectInput(pin, level) {
      injected.push({ pin, level });
      if (pin === 4) onWrite?.(2, level === 0 ? 1 : 0);
    },
  };
}

describe('引擎B 输入注入 + GPIO 断言（M5，stub gpioChannel）', () => {
  const inputScript = (): GoldenScript => ({
    ...baseScript(),
    input: [
      { atMs: 30, gpio: 4, level: 0 },
      { atMs: 80, gpio: 4, level: 0, release: true },
      { atMs: 130, gpio: 4, level: 0 },
      { atMs: 180, gpio: 4, level: 0, release: true },
    ],
    expect: { serialCycle: ['LED ON', 'LED OFF'], gpio: { pin: 2, highs: 2, lows: 2 } },
  });

  function setup(dirKey: string) {
    const db = setupDb();
    const dir = mkdtempSync(join(tmpdir(), dirKey));
    const config = appConfigSchema.parse({
      builds: { dir: join(dir, 'builds') },
      flash: { dir: join(dir, 'flash') },
      tools: { qemuXtensa: 'qemu-fake', qemuRiscv32: 'qemu-fake' },
    });
    return { db, dir, config };
  }

  it('input 序列按 atMs 注入（release 回退 pullup 电平 1）→ GPIO_WRITE 计数断言通过', async () => {
    const { db, dir, config } = setup('golden-b-');
    const injected: Array<{ pin: number; level: 0 | 1 }> = [];
    const result = await runGoldenEngineB(inputScript(), {
      db,
      config,
      buildRunner: async (_f, _a, o) => {
        o.onLine('ok');
        return { exitCode: 0 };
      },
      gpioChannel: fakeFirmwareChannel(injected),
      serialCollector: async (onLine) => {
        // 等待 input 序列 4 次注入全部完成（真实路径中由 durationMs 窗口保证）
        const t0 = Date.now();
        while (injected.length < 4 && Date.now() - t0 < 2000) {
          await new Promise((r) => setTimeout(r, 5));
        }
        onLine('LED ON');
        onLine('LED OFF');
        onLine('LED ON');
        onLine('LED OFF');
      },
    });

    expect(result.ok).toBe(true);
    expect(result.gpio).toEqual({ pin: 2, highs: 2, lows: 2, pwmWrites: 0 });
    // 注入序列：按下 0 → 释放回退 pullup 1 ×2 轮（05-§1.4 release 语义）
    expect(injected).toEqual([
      { pin: 4, level: 0 },
      { pin: 4, level: 1 },
      { pin: 4, level: 0 },
      { pin: 4, level: 1 },
    ]);
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });

  it('GPIO 计数不达标 → ok=false + gpio 明细', async () => {
    const { db, dir, config } = setup('golden-b-fail-');
    const injected: Array<{ pin: number; level: 0 | 1 }> = [];
    const result = await runGoldenEngineB(inputScript(), {
      db,
      config,
      buildRunner: async (_f, _a, o) => {
        o.onLine('ok');
        return { exitCode: 0 };
      },
      // 只按一次不释放 → LED 仅一轮置高/无释放（计数不足）
      gpioChannel: {
        onGpioWrite: (cb) => cb(2, 1),
        onPinMode: () => {},
        injectInput: (pin, level) => injected.push({ pin, level }),
      },
      serialCollector: async (onLine) => {
        onLine('LED ON');
        onLine('LED OFF');
        onLine('LED ON');
        onLine('LED OFF');
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('gpio pin2');
    expect(result.gpio).toEqual({ pin: 2, highs: 1, lows: 0, pwmWrites: 0 });
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });
});
