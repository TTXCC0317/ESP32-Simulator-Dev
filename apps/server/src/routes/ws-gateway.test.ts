import { describe, it, expect, afterEach, vi } from 'vitest';
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
 *
 * CI 慢机加固（run #20 flake）：本文件真实 TCP + 大量异步重试时序（桥接
 * connectGpioSerial 150ms×N 重试、reconnectGrace 400ms 等），双核 runner 并行
 * 23 文件时单条消息等待可能超过默认 3s/5s——等待类超时放宽到 10s/30s，
 * 断言逻辑不变（真失败仍会失败，只是不再被慢 CI 误杀）。
 */
vi.setConfig({ testTimeout: 30_000 });

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

  next(timeoutMs = 10_000): Promise<AnyMsg> {
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
  async until(pred: (m: AnyMsg) => boolean, timeoutMs = 10_000): Promise<AnyMsg> {
    for (;;) {
      const m = await this.next(timeoutMs);
      if (pred(m)) return m;
    }
  }

  close(): void {
    this.ws.close();
  }
}

/** fake QEMU：记录 args；所有 -serial tcp 模拟 server 监听并收集连接 */
class FakeQemu extends EventEmitter {
  readonly args: string[];
  readonly ports: number[];
  readonly conns: net.Socket[] = [];
  pid = 999;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill: (signal?: NodeJS.Signals) => boolean;
  private readonly servers: net.Server[] = [];

  constructor(args: string[]) {
    super();
    this.args = args;
    this.ports = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-serial') {
        const p = Number(/tcp:127\.0\.0\.1:(\d+),/.exec(args[i + 1] ?? '')?.[1] ?? 0);
        if (p > 0) this.ports.push(p);
      }
    }
    for (const port of this.ports) {
      const srv = net.createServer();
      srv.on('connection', (c) => {
        this.conns.push(c);
        this.emit('conn', c);
      });
      srv.listen(port, '127.0.0.1');
      this.servers.push(srv);
    }
    this.kill = (signal?: NodeJS.Signals): boolean => {
      if (this.exitCode !== null) return true;
      this.exitCode = 0;
      for (const srv of this.servers) srv.close();
      for (const c of this.conns) c.destroy();
      queueMicrotask(() => this.emit('exit', 0, signal ?? null));
      return true;
    };
  }

  /** 模拟 QEMU 异常退出（非主动 kill） */
  crash(code = 1): void {
    this.exitCode = code;
    for (const srv of this.servers) srv.close();
    for (const c of this.conns) c.destroy();
    this.emit('exit', code, null);
  }

  /** 取指定端口的已连接 socket（0=UART0 串口；1=GPIO 桥） */
  connOn(listenPort: number): net.Socket | undefined {
    return this.conns.find((c) => c.localPort === listenPort);
  }

  /** 等待指定端口有连接（网关异步 connect） */
  async waitConn(listenPort: number, timeoutMs = 10_000): Promise<net.Socket> {
    const hit = this.connOn(listenPort);
    if (hit) return hit;
    return new Promise((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error(`等待连接超时（port ${listenPort}）`)),
        timeoutMs,
      );
      this.once('conn', (c: net.Socket) => {
        if (c.localPort === listenPort) {
          clearTimeout(timer);
          res(c);
        }
      });
    });
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
    const uartPort = (s.children[0] as FakeQemu).ports[0] as number;
    (s.children[0] as FakeQemu).connOn(uartPort)?.write(Buffer.from('LED ON\n'));
    const rx = await c.until((m) => m.type === 'uart.rx');
    const bytes = (rx.payload as { bytes: number[] }).bytes;
    expect(String.fromCharCode(...bytes)).toBe('LED ON\n');

    // 串口泵（前端 → stub）：input.uart
    const dataPromise = new Promise<string>((res) => {
      const conn = (s.children[0] as FakeQemu).connOn(uartPort) as net.Socket;
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

/** M5 GPIO 桥电路：板卡 + 按键（btn1:1.l → esp:GPIO4）+ 孤立 LED（未接 GPIO） */
function makeGpioCircuit(): unknown {
  return {
    formatVersion: 1,
    boardType: 'esp32-devkit-c-v4',
    parts: [
      { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 0, top: 0, rotate: 0, attrs: {} },
      { id: 'btn1', type: 'wokwi-pushbutton', left: 300, top: 100, rotate: 0, attrs: {} },
      { id: 'led1', type: 'wokwi-led', left: 300, top: 220, rotate: 0, attrs: {} },
    ],
    connections: [{ id: 'w1', source: 'btn1:1.l', target: 'esp:GPIO4', color: 'green', path: [] }],
    serialMonitor: { baudrate: 115200 },
  };
}

/** 提取帧有效载荷 [type, pin, value]（5 字节定长） */
function framePayloads(buf: Buffer): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i + 4 < buf.length; i += 5) {
    out.push([buf[i + 1] as number, buf[i + 2] as number, buf[i + 3] as number]);
  }
  return out;
}

function bridgeFrame(type: number, pin: number, value: number): Buffer {
  return Buffer.from([0xa5, type, pin, value, (0xa5 ^ type ^ pin ^ value) & 0xff]);
}

describe('WS 网关 GPIO 桥（M5，03-§7.2）', () => {
  /** attach 成功并等待 running + GPIO 桥连接，返回 ws 客户端与桥 socket */
  async function attachWithBridge(
    s: Setup,
    sid: string,
  ): Promise<{ c: WsClient; gpio: net.Socket }> {
    const buildId = await submitBuild(s);
    await awaitBuildStatus(s, buildId, 'success');
    const c = new WsClient(wsUrl(s, sid));
    await c.opened;
    c.send({
      type: 'attach',
      payload: {
        projectId: s.projectId,
        circuit: makeGpioCircuit(),
        firmwareId: buildId,
        boardType: 'esp32-devkit-c-v4',
      },
    });
    await c.until(
      (m) => m.type === 'state' && (m.payload as { status: string }).status === 'running',
    );
    const child = s.children[0] as FakeQemu;
    const gpio = await child.waitConn(child.ports[1] as number);
    return { c, gpio };
  }

  it('input.pin：按键引脚沿连接映射 GPIO4 → 桥注入 GPIO_INPUT 帧', async () => {
    const s = await setup({});
    const { c, gpio } = await attachWithBridge(s, 'sid-m5-inject');

    const got = new Promise<Buffer>((res) => gpio.once('data', (d: Buffer) => res(d)));
    c.send({ type: 'input.pin', payload: { partId: 'btn1', pin: '1.l', level: 0 } });
    const frame = await got;
    // type=0x11 GPIO_INPUT, pin=4（GPIO4 映射）, value=0
    expect(framePayloads(frame)).toEqual([[0x11, 4, 0]]);

    c.send({ type: 'input.pin', payload: { partId: 'btn1', pin: '1.l', level: 1 } });
    const frame2 = await new Promise<Buffer>((res) => gpio.once('data', (d: Buffer) => res(d)));
    expect(framePayloads(frame2)).toEqual([[0x11, 4, 1]]);

    c.close();
  });

  it('release：PIN_MODE 上报 pullup 后松开回退电平 1（05-§1.4）', async () => {
    const s = await setup({});
    const { c, gpio } = await attachWithBridge(s, 'sid-m5-release');

    // 固件上报 INPUT_PULLUP（0x05）
    gpio.write(bridgeFrame(0x02, 4, 0x05));
    await new Promise((r) => setImmediate(r));

    const frames: Buffer[] = [];
    gpio.on('data', (d: Buffer) => frames.push(d));
    c.send({ type: 'input.pin', payload: { partId: 'btn1', pin: '1.l', level: 0 } }); // 按下
    await new Promise((r) => setTimeout(r, 20));
    c.send({ type: 'input.pin', payload: { partId: 'btn1', pin: '1.l', level: 0, release: true } }); // 松开
    await new Promise((r) => setTimeout(r, 20));

    expect(framePayloads(Buffer.concat(frames))).toEqual([
      [0x11, 4, 0], // 按下：注入 0
      [0x11, 4, 1], // 松开：回退 pullup 电平 1
    ]);
    c.close();
  });

  it('固件 GPIO_WRITE 帧 → 客户端 gpio.write 事件（seq 单调递增）', async () => {
    const s = await setup({});
    const { c, gpio } = await attachWithBridge(s, 'sid-m5-out');

    gpio.write(bridgeFrame(0x01, 4, 1));
    const m1 = await c.until((m) => m.type === 'gpio.write');
    expect(m1.payload).toMatchObject({ pin: 4, level: 1, seq: 1 });

    gpio.write(bridgeFrame(0x01, 4, 0));
    const m2 = await c.until((m) => m.type === 'gpio.write');
    expect(m2.payload).toMatchObject({ pin: 4, level: 0, seq: 2 });
    c.close();
  });

  it('未连接板卡 GPIO 的引脚 → error.ack NO_GPIO', async () => {
    const s = await setup({});
    const { c } = await attachWithBridge(s, 'sid-m5-nogpio');

    c.send({ type: 'input.pin', payload: { partId: 'led1', pin: 'A', level: 1 } });
    const err = await c.until((m) => m.type === 'error.ack');
    expect((err.payload as { code: string }).code).toBe('NO_GPIO');
    c.close();
  });

  it('桥 socket 异常断开 → input.pin 返回 NO_GPIO_BRIDGE，会话保持 running', async () => {
    const s = await setup({});
    const { c, gpio } = await attachWithBridge(s, 'sid-m5-drop');
    gpio.destroy();
    await new Promise((r) => setTimeout(r, 20));

    c.send({ type: 'input.pin', payload: { partId: 'btn1', pin: '1.l', level: 0 } });
    const err = await c.until((m) => m.type === 'error.ack');
    expect((err.payload as { code: string }).code).toBe('NO_GPIO_BRIDGE');
    // 会话未因桥断开失败（REST 状态仍 running）
    const res = await s.app.inject({ method: 'GET', url: '/api/sessions/sid-m5-drop' });
    expect((res.json() as { state: string }).state).toBe('running');
    c.close();
  });
});
