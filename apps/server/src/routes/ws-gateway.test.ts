import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { appConfigSchema, type AppConfig } from '../config/schema';
import { openDatabase, type Db } from '../db/client';
import { runMigrations } from '../db/migrator';
import { buildApp, type BuildAppOptions } from '../app';
import type { ToolsStatus } from '../services/tools-probe';
import type { BuildRunner } from '../services/build.service';
import type { SpawnQemuFn } from '../services/qemu.manager';

/**
 * L3（02-§4 M4 测试项）：WS 会话网关协议正反向 + 状态机转移（03-§7.3/§7.4）
 * 真实 listen + ws 客户端；编译 runner / QEMU spawn 用 stub（串口 TCP 由 stub 模拟）。
 */

const stubTools: ToolsStatus = {
  node: 'v22',
  git: { ok: true, version: '2.45' },
  arduinoCli: { ok: false, reason: 'stub' },
  esptool: { ok: false, reason: 'stub' },
  qemu: { ok: false, reason: 'stub' },
};

type AnyMsg = Record<string, unknown> & { type: string };

/** ws 测试客户端：消息入队 + 断言式取用 */
class WsClient {
  private readonly ws: WebSocket;
  private readonly queue: AnyMsg[] = [];
  private readonly received: string[] = [];
  private readonly waiters: Array<{
    res: (m: AnyMsg) => void;
    rej: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw: Buffer) => {
      const m = JSON.parse(raw.toString('utf8')) as AnyMsg;
      this.received.push(m.type);
      const w = this.waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.res(m);
      } else {
        this.queue.push(m);
      }
    });
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  /** 发送原始文本（非法 JSON 用例） */
  sendRaw(text: string): void {
    this.ws.send(text);
  }

  /** 立即断 TCP（模拟断线，服务端 close 事件即时触发） */
  terminate(): void {
    this.ws.terminate();
  }

  next(timeoutMs = 3000): Promise<AnyMsg> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        rej(new Error(`等待 WS 消息超时（已收：[${this.received.join(', ')}]）`));
      }, timeoutMs);
      this.waiters.push({ res, rej, timer });
    });
  }

  /** 依次取消息直到满足 pred（跳过无关消息） */
  async until(pred: (m: AnyMsg) => boolean, timeoutMs = 3000): Promise<AnyMsg> {
    for (;;) {
      const m = await this.next(timeoutMs);
      if (pred(m)) return m;
    }
  }

  close(): void {
    this.ws.close();
  }
}

/** fake QEMU：记录 args；-serial tcp 模拟 server 监听并收集连接 */
class FakeQemu extends EventEmitter {
  readonly args: string[];
  readonly conns: net.Socket[] = [];
  pid = 999;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill: (signal?: NodeJS.Signals) => boolean;
  private readonly server: net.Server;

  constructor(args: string[]) {
    super();
    this.args = args;
    const si = args.indexOf('-serial');
    const port = Number(/tcp:127\.0\.0\.1:(\d+),/.exec(args[si + 1] ?? '')?.[1] ?? 0);
    this.server = net.createServer();
    if (port > 0) {
      this.server.on('connection', (c) => this.conns.push(c));
      this.server.listen(port, '127.0.0.1');
    }
    this.kill = (signal?: NodeJS.Signals): boolean => {
      if (this.exitCode !== null) return true;
      this.exitCode = 0;
      this.server.close();
      for (const c of this.conns) c.destroy();
      queueMicrotask(() => this.emit('exit', 0, signal ?? null));
      return true;
    };
  }

  /** 模拟 QEMU 异常退出（非主动 kill） */
  crash(code = 1): void {
    this.exitCode = code;
    this.server.close();
    for (const c of this.conns) c.destroy();
    this.emit('exit', code, null);
  }
}

interface Setup {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: Db;
  port: number;
  projectId: string;
  children: FakeQemu[];
  dir: string;
  config: AppConfig;
}

const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop() as () => void;
    try {
      await fn();
    } catch {
      // 忽略重复清理
    }
  }
});

/** 编译 stub：ok 模式产出 flash.img；gate 挂起控制时序；fail 模式抛编译错误 */
function makeRunner(
  mode: 'ok' | 'fail' | 'timeout',
  gate?: { hold?: Promise<void>; onLines?: (onLine: (l: string) => void) => void },
): BuildRunner {
  return async (file, args, opts) => {
    if (file.includes('arduino-cli')) {
      if (gate?.hold) await gate.hold;
      gate?.onLines?.(opts.onLine);
      if (mode === 'timeout') throw new Error('编译超时（300s）');
      opts.onLine('Compiling sketch...');
      if (mode === 'fail') throw new Error('sketch.ino: error: expected ;');
      return { exitCode: 0 };
    }
    const oi = args.indexOf('-o');
    writeFileSync(args[oi + 1] ?? '', Buffer.alloc(1024));
    return { exitCode: 0 };
  };
}

async function setup(opts: {
  runnerMode?: 'ok' | 'fail' | 'timeout';
  gate?: Parameters<typeof makeRunner>[1];
  flashOverrides?: Partial<AppConfig['flash']>;
}): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), 'esp32sim-ws-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const base = appConfigSchema.parse({});
  const config: AppConfig = {
    ...base,
    builds: { ...base.builds, dir: join(dir, 'builds') },
    flash: { ...base.flash, dir: join(dir, 'flash'), ...opts.flashOverrides },
    // stub spawn 不真跑进程，给假路径绕过"未配置"检查
    tools: {
      ...base.tools,
      qemuXtensa: 'qemu-system-xtensa-fake',
      qemuRiscv32: 'qemu-system-riscv32-fake',
    },
  };
  const db = openDatabase({ path: ':memory:', wal: false });
  runMigrations(db);

  const children: FakeQemu[] = [];
  const spawnFn: SpawnQemuFn = (_f, args) => {
    const c = new FakeQemu(args);
    children.push(c);
    return c as unknown as ChildProcess;
  };

  const appOpts: BuildAppOptions = {
    config,
    db,
    probe: async () => stubTools,
    buildRunner: makeRunner(opts.runnerMode ?? 'ok', opts.gate),
    qemuSpawn: spawnFn,
  };
  const app = await buildApp(appOpts);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;

  const pres = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'ws' } });
  expect(pres.statusCode).toBe(201);
  const projectId = (pres.json() as { id: string }).id;
  db.prepare(
    "INSERT INTO project_files (id, project_id, path, content) VALUES ('f1', ?, 'sketch.ino', 'void setup(){}')",
  ).run(projectId);

  cleanups.push(async () => {
    for (const c of children) if (c.exitCode === null) c.kill();
    await app.close();
    db.close();
  });

  return { app, db, port, projectId, children, dir, config };
}

async function submitBuild(setupRes: Setup): Promise<string> {
  const res = await setupRes.app.inject({
    method: 'POST',
    url: '/api/build',
    payload: { projectId: setupRes.projectId, toolchain: 'arduino' },
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { buildId: string }).buildId;
}

async function awaitBuildStatus(
  setupRes: Setup,
  buildId: string,
  want: 'success' | 'failed',
): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const res = await setupRes.app.inject({ method: 'GET', url: `/api/builds/${buildId}` });
    if ((res.json() as { status: string }).status === want) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`build 未达到 ${want}`);
}

function makeCircuit(): unknown {
  return {
    formatVersion: 1,
    boardType: 'esp32-devkit-c-v4',
    parts: [],
    connections: [],
    serialMonitor: { baudrate: 115200 },
  };
}

function wsUrl(setupRes: Setup, sid: string): string {
  return `ws://127.0.0.1:${setupRes.port}/ws/sim/${sid}`;
}

describe('WS 网关（03-§7.3 状态机 + §7.4 进度通道）', () => {
  it('attach（build success）→ running；串口双向泵；ctrl stop → closed', async () => {
    const s = await setup({});
    const buildId = await submitBuild(s);
    await awaitBuildStatus(s, buildId, 'success');

    const c = new WsClient(wsUrl(s, 'sid-ok'));
    await c.opened;
    c.send({
      type: 'attach',
      payload: {
        projectId: s.projectId,
        circuit: makeCircuit(),
        firmwareId: buildId,
        boardType: 'esp32-devkit-c-v4',
      },
    });
    expect((await c.until((m) => m.type === 'state')).payload).toMatchObject({
      status: 'attaching',
    });
    expect((await c.until((m) => m.type === 'state')).payload).toMatchObject({
      status: 'running',
    });

    // 串口泵（stub → 前端）：uart.rx bytes
    (s.children[0] as FakeQemu).conns[0]?.write(Buffer.from('LED ON\n'));
    const rx = await c.until((m) => m.type === 'uart.rx');
    const bytes = (rx.payload as { bytes: number[] }).bytes;
    expect(String.fromCharCode(...bytes)).toBe('LED ON\n');

    // 串口泵（前端 → stub）：input.uart
    const dataPromise = new Promise<string>((res) => {
      const conn = (s.children[0] as FakeQemu).conns[0] as net.Socket;
      conn.once('data', (d: Buffer) => res(d.toString('utf8')));
    });
    c.send({ type: 'input.uart', payload: { bytes: [104, 105] } }); // 'hi'
    expect(await dataPromise).toBe('hi');

    // ctrl stop → closed
    c.send({ type: 'ctrl', payload: 'stop' });
    expect((await c.until((m) => m.type === 'state')).payload).toMatchObject({
      status: 'closed',
    });
    c.close();
  });

  it('attach（build failed）→ state error + 失败日志', async () => {
    const s = await setup({ runnerMode: 'fail' });
    const buildId = await submitBuild(s);
    await awaitBuildStatus(s, buildId, 'failed');

    const c = new WsClient(wsUrl(s, 'sid-fail'));
    await c.opened;
    c.send({
      type: 'attach',
      payload: {
        projectId: s.projectId,
        circuit: makeCircuit(),
        firmwareId: buildId,
        boardType: 'esp32-devkit-c-v4',
      },
    });
    const errState = await c.until(
      (m) => m.type === 'state' && (m.payload as { status: string }).status === 'error',
    );
    expect(String((errState.payload as { error: string }).error)).toContain('编译失败');
    c.close();
  });

  it('building-wait：attach 时编译进行中 → progress 推送（普通行聚合 + critical 立即）→ success → running', async () => {
    let gateRelease: (() => void) | null = null;
    const gateHold = new Promise<void>((res) => (gateRelease = res));
    const s = await setup({
      gate: {
        hold: gateHold,
        onLines: (onLine) => {
          onLine('Compiling core a.c');
          onLine('error: foo.h not found');
          onLine('Compiling core b.c');
        },
      },
    });
    const buildId = await submitBuild(s);

    const c = new WsClient(wsUrl(s, 'sid-wait'));
    await c.opened;
    c.send({
      type: 'attach',
      payload: {
        projectId: s.projectId,
        circuit: makeCircuit(),
        firmwareId: buildId,
        boardType: 'esp32-devkit-c-v4',
      },
    });

    // compiling + progress（订阅晚于早期事件 → 补发当前状态）
    const prog = await c.until((m) => m.type === 'build.progress');
    expect((prog.payload as { phase: string }).phase).toMatch(/queued|compiling/);

    // 释放编译 gate：普通行进 100ms 聚合窗口，critical 行立即推送（logLine）
    gateRelease!(); // executor 同步执行，release 必已赋值

    const critical = await c.until(
      (m) => m.type === 'build.progress' && !!(m.payload as { logLine?: string }).logLine,
    );
    expect((critical.payload as { logLine: string }).logLine).toContain('error: foo.h not found');

    // 完成编译 → success → running
    await c.until(
      (m) => m.type === 'build.progress' && (m.payload as { phase: string }).phase === 'success',
    );
    const running = await c.until((m) => m.type === 'state');
    expect((running.payload as { status: string }).status).toBe('running');
    c.close();
  });

  it('ctrl pause → error.ack UNSUPPORTED；非法 JSON / 非法消息 → error.ack', async () => {
    const s = await setup({});
    const buildId = await submitBuild(s);
    await awaitBuildStatus(s, buildId, 'success');

    const c = new WsClient(wsUrl(s, 'sid-ctrl'));
    await c.opened;
    c.send({
      type: 'attach',
      payload: {
        projectId: s.projectId,
        circuit: makeCircuit(),
        firmwareId: buildId,
        boardType: 'esp32-devkit-c-v4',
      },
    });
    await c.until(
      (m) => m.type === 'state' && (m.payload as { status: string }).status === 'running',
    );

    c.send({ type: 'ctrl', payload: 'pause' });
    const ack = await c.until((m) => m.type === 'error.ack');
    expect((ack.payload as { code: string }).code).toBe('UNSUPPORTED');

    // 非法 JSON → error.ack（BAD_JSON）
    c.sendRaw('not-json');
    const badJson = await c.until((m) => m.type === 'error.ack');
    expect((badJson.payload as { code: string }).code).toBe('BAD_JSON');

    // 合法 JSON 但非协议消息 → error.ack（VALIDATION_FAILED）
    c.sendRaw(JSON.stringify({ type: 'nope' }));
    const badMsg = await c.until((m) => m.type === 'error.ack');
    expect((badMsg.payload as { code: string }).code).toBe('VALIDATION_FAILED');
    c.close();
  });

  it('QEMU 进程异常退出 → state error + error.ack（QEMU_EXIT）', async () => {
    const s = await setup({});
    const buildId = await submitBuild(s);
    await awaitBuildStatus(s, buildId, 'success');

    const c = new WsClient(wsUrl(s, 'sid-exit'));
    await c.opened;
    c.send({
      type: 'attach',
      payload: {
        projectId: s.projectId,
        circuit: makeCircuit(),
        firmwareId: buildId,
        boardType: 'esp32-devkit-c-v4',
      },
    });
    await c.until(
      (m) => m.type === 'state' && (m.payload as { status: string }).status === 'running',
    );

    (s.children[0] as FakeQemu).crash(1);
    await c.until(
      (m) => m.type === 'state' && (m.payload as { status: string }).status === 'error',
    );
    const ack = await c.until((m) => m.type === 'error.ack');
    expect((ack.payload as { code: string }).code).toBe('QEMU_EXIT');
    c.close();
  });

  it('断线重连（reconnectGraceMs 内同 sid）→ 接管 running 会话；超时不重连 → 回收 404', async () => {
    const s = await setup({ flashOverrides: { reconnectGraceMs: 400 } });
    const buildId = await submitBuild(s);
    await awaitBuildStatus(s, buildId, 'success');

    const a = new WsClient(wsUrl(s, 'sid-re'));
    await a.opened;
    a.send({
      type: 'attach',
      payload: {
        projectId: s.projectId,
        circuit: makeCircuit(),
        firmwareId: buildId,
        boardType: 'esp32-devkit-c-v4',
      },
    });
    await a.until(
      (m) => m.type === 'state' && (m.payload as { status: string }).status === 'running',
    );
    a.terminate(); // 立即断 TCP（close 握手太慢，避免 b 被拒 session already attached）
    await new Promise((r) => setTimeout(r, 80)); // 等服务端 close 事件置 socket=null

    // 立即重连：接管，重推 state running
    const b = new WsClient(wsUrl(s, 'sid-re'));
    await b.opened;
    const st = await b.until((m) => m.type === 'state');
    expect((st.payload as { status: string }).status).toBe('running');
    b.close();

    // 不重连路径：新会话断开 → grace 过期 → 回收
    const d = new WsClient(wsUrl(s, 'sid-gone'));
    await d.opened;
    d.send({
      type: 'attach',
      payload: {
        projectId: s.projectId,
        circuit: makeCircuit(),
        firmwareId: buildId,
        boardType: 'esp32-devkit-c-v4',
      },
    });
    await d.until((m) => m.type === 'state');
    d.close();
    await new Promise((r) => setTimeout(r, 600));
    const res = await s.app.inject({ method: 'GET', url: '/api/sessions/sid-gone' });
    expect(res.statusCode).toBe(404);
  });

  it('REST 会话指标：/api/metrics/sessions 返回总数与状态分布', async () => {
    const s = await setup({});
    const buildId = await submitBuild(s);
    await awaitBuildStatus(s, buildId, 'success');

    const c = new WsClient(wsUrl(s, 'sid-m'));
    await c.opened;
    c.send({
      type: 'attach',
      payload: {
        projectId: s.projectId,
        circuit: makeCircuit(),
        firmwareId: buildId,
        boardType: 'esp32-devkit-c-v4',
      },
    });
    await c.until(
      (m) => m.type === 'state' && (m.payload as { status: string }).status === 'running',
    );

    const res = await s.app.inject({ method: 'GET', url: '/api/metrics/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number; byState: Record<string, number> };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.byState.running).toBeGreaterThanOrEqual(1);
    c.close();
  });
});
