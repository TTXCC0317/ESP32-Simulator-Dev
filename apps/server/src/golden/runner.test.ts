import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfigSchema } from '../config/schema';
import { openDatabase } from '../db/client';
import { runMigrations } from '../db/migrator';
import { assertSerialCycle, runGoldenEngineA, runGoldenEngineB, loadGoldenScript } from './runner';
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
});
