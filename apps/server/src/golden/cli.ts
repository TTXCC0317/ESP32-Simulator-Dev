import { closeSync, openSync, writeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/loader';
import { openDatabase } from '../db/client';
import { runMigrations } from '../db/migrator';
import { runGoldenEngineA, runGoldenEngineB, loadGoldenScript } from './runner';
import type { GoldenEngine } from './golden-schema';

/**
 * Golden CLI（02-§3.2 L5 / e2e.yml golden job）：
 *   pnpm golden [--example blink] [--engine qemu-remote|micropython-wasm|both] [--out <file>]
 * 退出码：任一用例 fail → 1（CI 阻塞）；--out 将结果行同步落盘（CI artifact / 本地核查）。
 */

interface Args {
  example: string;
  engine: GoldenEngine | 'both';
  out?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : def;
  };
  const engine = get('--engine', 'both');
  if (engine !== 'both' && engine !== 'micropython-wasm' && engine !== 'qemu-remote') {
    throw new Error(`未知 --engine：${engine}`);
  }
  return {
    example: get('--example', 'blink'),
    engine: engine as Args['engine'],
    out: get('--out', '') || undefined,
  };
}

async function main(): Promise<void> {
  const { example, engine, out } = parseArgs();
  const script = loadGoldenScript(example);
  const results = [];

  // 双引擎共用一个内存库（各自实例化临时工程；golden-a-*/golden-* 命名不冲突）。
  // 配置/相对路径一律锚定仓库根（pnpm --filter exec 的 cwd 是 apps/server）。
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  process.chdir(REPO_ROOT);
  const config = loadConfig(join(REPO_ROOT, 'config', 'app.json'));
  const db = openDatabase({ path: ':memory:', wal: false });
  runMigrations(db);
  try {
    if (engine === 'micropython-wasm' || engine === 'both') {
      results.push(await runGoldenEngineA(script, { db }));
    }
    if (engine === 'qemu-remote' || engine === 'both') {
      // 真实工具链路径来自 config/app.json（arduino-cli/esptool/QEMU；02-§3.2 L5）
      results.push(await runGoldenEngineB(script, { db, config }));
    }
  } finally {
    db.close();
  }

  let failed = 0;
  const report: Array<{ fd: number; line: string }> = [];
  for (const r of results) {
    if (r.ok) {
      report.push({
        fd: 1,
        line: `[PASS] ${r.exampleId} × ${r.engine}（${r.serialLines.length} 行串口）`,
      });
    } else {
      failed += 1;
      report.push({ fd: 2, line: `[FAIL] ${r.exampleId} × ${r.engine}: ${r.error ?? 'unknown'}` });
      if (r.serialLines.length > 0) {
        report.push({ fd: 2, line: `  末尾串口：${r.serialLines.slice(-5).join(' | ')}` });
      }
    }
  }
  // 同步写 fd：结果行不可丢（stdout 重定向时异步缓冲会被 process.exit 截断）
  for (const { fd, line } of report) writeSync(fd, `${line}\n`);
  if (out) {
    // 结果行独立落盘（--out）：不依赖 stdout 管道，本地/CI 均可核查
    const fd = openSync(resolve(process.cwd(), out), 'w');
    try {
      writeSync(fd, `${report.map((x) => x.line).join('\n')}\n`);
    } finally {
      closeSync(fd);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main();
