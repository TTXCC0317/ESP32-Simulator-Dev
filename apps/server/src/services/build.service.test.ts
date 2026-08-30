import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfigSchema, type AppConfig } from '../config/schema';
import { openDatabase, type Db } from '../db/client';
import { runMigrations } from '../db/migrator';
import { BuildService, type BuildRunner, type BuildEvent } from './build.service';

/**
 * L1（02-§4 M4 测试项）：build.service 状态机
 * queued → running → success / failed / timeout；并发排队（maxConcurrent=2，第 3 个等待）。
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    const fn = cleanups.pop() as () => void;
    try {
      fn();
    } catch {
      // 临时目录已清理可忽略
    }
  }
});

interface Ctx {
  db: Db;
  service: BuildService;
  config: AppConfig;
  dir: string;
  projectId: string;
}

function setup(runner: BuildRunner, cfgOverrides: Partial<AppConfig['builds']> = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'esp32sim-build-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const base = appConfigSchema.parse({});
  const config: AppConfig = {
    ...base,
    builds: { ...base.builds, dir: join(dir, 'builds'), ...cfgOverrides },
  };
  const db = openDatabase({ path: ':memory:', wal: false });
  runMigrations(db);
  cleanups.push(() => db.close());

  db.prepare(
    "INSERT INTO projects (id, name, board_type, engine, diagram, created_at, updated_at) VALUES ('p1', 't', 'esp32-devkit-c-v4', 'micropython-wasm', '{}', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO project_files (id, project_id, path, content) VALUES ('f1', 'p1', 'sketch.ino', 'void setup(){}')",
  ).run();

  const service = new BuildService({ db, config, run: runner });
  return { db, service, config, dir, projectId: 'p1' };
}

/** stub runner：arduino-cli 打日志；esptool 写 1.6MB flash.img（超 1.5MB 最小镜像） */
function makeRunner(
  mode: 'ok' | 'fail' | 'timeout',
  hooks?: { onCompile?: (cwd: string) => Promise<void> | void },
): BuildRunner & { calls: Array<{ file: string; args: string[]; cwd: string }> } {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const fn = (async (file: string, args: string[], opts) => {
    calls.push({ file, args, cwd: opts.cwd });
    if (file.includes('arduino-cli')) {
      await hooks?.onCompile?.(opts.cwd);
      if (mode === 'timeout') throw new Error('编译超时（300s），进程已终止');
      opts.onLine('Compiling sketch...');
      opts.onLine('warning: unused variable x');
      if (mode === 'fail') throw new Error('sketch.ino:1:1: error: expected ; before }');
      return { exitCode: 0 };
    }
    // esptool merge_bin：产物写 -o 目标
    const oi = args.indexOf('-o');
    const imgPath = args[oi + 1] ?? '';
    if (mode === 'ok') writeFileSync(imgPath, Buffer.alloc(1.6 * 1024 * 1024));
    return { exitCode: 0 };
  }) as BuildRunner & { calls: Array<{ file: string; args: string[]; cwd: string }> };
  fn.calls = calls;
  return fn;
}

describe('BuildService 状态机（03-§7.1）', () => {
  it('queued → running → success，产物 flash.img 落盘且 artifact 记录', async () => {
    const runner = makeRunner('ok');
    const { service } = setup(runner);
    const { buildId } = service.submit('p1', 'arduino');

    // runJob 的同步段立即把状态推到 running（queued 状态仅存在于事件流）
    expect(['queued', 'running']).toContain(service.status(buildId)?.status);

    const rec = await service.waitForFinish(buildId);
    expect(rec.status).toBe('success');
    expect(rec.artifact).toBe('flash.img');
    expect(rec.startedAt).not.toBeNull();
    expect(rec.finishedAt).not.toBeNull();

    const img = join(service.buildDir(buildId), 'flash.img');
    expect(existsSync(img)).toBe(true);
    // 日志流：编译行已累积
    expect(service.logs(buildId)).toContain('Compiling sketch...');
    // runner 调用序列：compile → merge_bin
    expect(runner.calls.map((c) => (c.file.includes('arduino') ? 'cli' : 'esptool'))).toEqual([
      'cli',
      'esptool',
    ]);
    // compile 参数数组化含 fqbn（FlashMode=dio：QEMU 不支持 QIO 启动断言）与源码目录
    const cliCall = runner.calls[0] as { file: string; args: string[]; cwd: string };
    expect(cliCall.args).toContain('esp32:esp32:esp32:FlashMode=dio');
  });

  it('编译失败（exit 非 0）→ failed + error 行进日志', async () => {
    const { service } = setup(makeRunner('fail'));
    const { buildId } = service.submit('p1', 'arduino');
    const rec = await service.waitForFinish(buildId);
    expect(rec.status).toBe('failed');
    expect(rec.artifact).toBeNull();
    expect(service.logs(buildId).some((l) => l.includes('error: expected'))).toBe(true);
  });

  it('M5 GPIO 桥：glue 源随 sketch 落盘（强符号覆盖，无需 build-property 注入）', async () => {
    const runner = makeRunner('ok');
    const { service } = setup(runner);
    const { buildId } = service.submit('p1', 'arduino');
    await service.waitForFinish(buildId);

    // 强符号覆盖方案：core 3.x 的 digitalWrite 等是 weak alias，glue 强定义公开符号
    // 即被链接器优先采用，编译命令无需 -Wl,--wrap（wrap 对 weak alias 静默失效）
    const cliCall = runner.calls[0] as { file: string; args: string[]; cwd: string };
    expect(cliCall.args).not.toContain('--build-property');

    // glue 源文件注入 sketch 沙箱（随固件一起编译）
    expect(existsSync(join(cliCall.cwd, 'src', 'sketch', 'esp32sim_bridge.c'))).toBe(true);
  });

  it('编译超时 → failed（runner 以 timeout 错误终止）', async () => {
    const { service } = setup(makeRunner('timeout'));
    const { buildId } = service.submit('p1', 'arduino');
    const rec = await service.waitForFinish(buildId);
    expect(rec.status).toBe('failed');
    expect(service.logs(buildId).join('\n')).toContain('编译超时');
  });

  it('并发排队：maxConcurrent=2，第 3 个编译在前 2 个完成前不启动', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((res) => (release = res));
    const started: string[] = [];
    const runner: BuildRunner = async (file, _args, opts) => {
      if (file.includes('arduino-cli')) {
        started.push(opts.cwd);
        if (started.length < 3) await gate; // 前 2 个挂起 → 槽位占满，第 3 个排队
        return { exitCode: 0 };
      }
      return { exitCode: 0 };
    };
    const { service } = setup(runner, { maxConcurrent: 2 });

    const ids = [
      service.submit('p1', 'arduino').buildId,
      service.submit('p1', 'arduino').buildId,
      service.submit('p1', 'arduino').buildId,
    ];
    // 前两个进入 running，第三个仍 queued
    await new Promise((r) => setTimeout(r, 20));
    expect(started.length).toBe(2);
    expect(service.status(ids[2] as string)?.status).toBe('queued');

    release!(); // executor 同步执行，release 必已赋值
    const recs = await Promise.all(ids.map((id) => service.waitForFinish(id)));
    expect(recs.map((r) => r.status)).toEqual(['success', 'success', 'success']);
    expect(started.length).toBe(3);
  });

  it('事件流：submit 推 queued，开始推 compiling，结束推 success', async () => {
    const { service } = setup(makeRunner('ok'));
    const events: Array<{ buildId: string; ev: BuildEvent }> = [];
    service.onEvent((buildId, ev) => events.push({ buildId, ev }));
    const { buildId } = service.submit('p1', 'arduino');
    await service.waitForFinish(buildId);
    const phases = events.filter((e) => e.buildId === buildId && e.ev.kind === 'phase');
    expect(phases.map((p) => p.ev.phase)).toEqual(['queued', 'compiling', 'merging', 'success']);
  });

  it('磁盘配额（06-§4.1）：超限清理最旧构建（pinned 跳过，artifact 置空）', async () => {
    const { service, db } = setup(makeRunner('ok'), { quotaMb: 2 }); // 2MB 配额，单产物 1.6MB

    const b1 = service.submit('p1', 'arduino').buildId;
    await service.waitForFinish(b1);
    // b1 固定保留
    db.prepare('UPDATE builds SET pinned = 1 WHERE id = ?').run(b1);

    const b2 = service.submit('p1', 'arduino').buildId;
    await service.waitForFinish(b2);
    // b1(pinned) + b2 = 3.2MB > 2MB → 清理跳过 b1，只能清 b2
    expect(existsSync(join(service.buildDir(b1), 'flash.img'))).toBe(true);
    expect(existsSync(join(service.buildDir(b2), 'flash.img'))).toBe(false);
    expect(db.prepare('SELECT artifact FROM builds WHERE id = ?').get(b2)).toEqual({
      artifact: null,
    });
  });

  it('submit 前置校验：无 .ino / 未知 toolchain 抛错且不落库', () => {
    const { service, db } = setup(makeRunner('ok'));
    db.prepare('DELETE FROM project_files WHERE path = ?').run('sketch.ino');
    expect(() => service.submit('p1', 'arduino')).toThrow(/\.ino/);
    expect(() => service.submit('p1', 'esp-idf')).toThrow(/M4 未支持/);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM builds').all() as Array<{ n: number }>)[0]?.n,
    ).toBe(0);
  });
});
