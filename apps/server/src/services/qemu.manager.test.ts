import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { appConfigSchema, type AppConfig } from '../config/schema';
import { QemuManager, type SpawnQemuFn } from './qemu.manager';

/**
 * L1（02-§4 M4 测试项）：QemuManager 生命周期
 * 正常退出 / 强杀 / 端口回收 / 空闲回收 / 未配置拒绝；N17 参数数组化断言。
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    const fn = cleanups.pop() as () => void;
    try {
      fn();
    } catch {
      // 已清理
    }
  }
});

/** fake QEMU 子进程：记录 args；kill 触发 exit；模拟 -serial tcp server 监听（UART0 + GPIO 桥） */
class FakeChild extends EventEmitter {
  readonly args: string[];
  pid = 42_000 + Math.floor(Math.random() * 1000);
  exitCode: number | null = null;
  signalCode: string | null = null;
  killCalls: Array<string | undefined> = [];
  kill: (signal?: NodeJS.Signals) => boolean;
  readonly serialServer: net.Server;
  readonly gpioServer: net.Server | null;

  constructor(args: string[]) {
    super();
    this.args = args;
    const ports = serialPortsOf(args);
    const p0 = ports[0] ?? 0;
    const p1 = ports[1] ?? 0;
    this.serialServer = net.createServer();
    if (p0 > 0) this.serialServer.listen(p0, '127.0.0.1');
    this.gpioServer = null;
    if (p1 > 0) {
      this.gpioServer = net.createServer();
      this.gpioServer.listen(p1, '127.0.0.1');
    }

    this.kill = (signal?: NodeJS.Signals): boolean => {
      this.killCalls.push(signal);
      if (this.exitCode !== null) return true;
      this.exitCode = signal === 'SIGKILL' ? 137 : 0;
      this.serialServer.close();
      this.gpioServer?.close();
      queueMicrotask(() => this.emit('exit', this.exitCode, signal ?? null));
      return true;
    };
  }
}

/** 提取 args 中所有 -serial tcp 端口（按出现顺序：UART0、UART1 桥） */
function serialPortsOf(args: string[]): number[] {
  const ports: number[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-serial') {
      ports.push(Number(/tcp:127\.0\.0\.1:(\d+),/.exec(args[i + 1] ?? '')?.[1] ?? 0));
    }
  }
  return ports;
}

interface Setup {
  mgr: QemuManager;
  children: FakeChild[];
  dir: string;
  firmwarePath: string;
}

function setup(cfgOverrides: Partial<AppConfig['flash']> = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'esp32sim-qemu-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const base = appConfigSchema.parse({});
  const config: AppConfig = {
    ...base,
    flash: { ...base.flash, dir: join(dir, 'flash'), ...cfgOverrides },
    // stub spawn 不真跑进程，给假路径绕过"未配置"检查
    tools: {
      ...base.tools,
      qemuXtensa: 'qemu-system-xtensa-fake',
      qemuRiscv32: 'qemu-system-riscv32-fake',
    },
  };
  const children: FakeChild[] = [];
  const spawnFn: SpawnQemuFn = (_file, args) => {
    const child = new FakeChild(args);
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const mgr = new QemuManager({ config, spawn: spawnFn });
  const firmwarePath = join(dir, 'src-flash.img');
  writeFileSync(firmwarePath, Buffer.alloc(1024));
  return { mgr, children, dir, firmwarePath };
}

describe('QemuManager（03-§7.2 N17）', () => {
  it('spawn：state=running，flash.img 拷入会话目录，端口在 40000-41000', async () => {
    const { mgr, children, firmwarePath, dir } = setup();
    const { sessionId, port } = await mgr.spawnSession({
      firmwarePath,
      boardType: 'esp32-devkit-c-v4',
    });

    expect(port).toBeGreaterThanOrEqual(40_000);
    expect(port).toBeLessThanOrEqual(41_000);
    const info = mgr.get(sessionId);
    expect(info?.state).toBe('running');
    expect(info?.pid).toBe((children[0] as FakeChild).pid);
    expect(existsSync(join(dir, 'flash', sessionId, 'flash.img'))).toBe(true);
  });

  it('N17 参数表：-machine esp32、-drive if=mtd、双 -serial tcp server nowait（UART0 + GPIO 桥）', async () => {
    const { mgr, children, firmwarePath } = setup();
    await mgr.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' });

    const args = (children[0] as FakeChild).args;
    expect(args[args.indexOf('-machine') + 1]).toBe('esp32');
    expect(args[args.indexOf('-drive') + 1]).toMatch(/flash\.img,if=mtd,format=raw$/);
    expect(args[args.indexOf('-monitor') + 1]).toBe('none');
    expect(args).toContain('-nographic');
    expect(args.filter((a) => a.startsWith('-gpio'))).toHaveLength(0);
    // M5：第二 -serial = UART1 GPIO 桥通道
    expect(serialPortsOf(args)).toHaveLength(2);
    expect(args.some((a) => /^tcp:127\.0\.0\.1:\d+,server,nowait$/.test(a))).toBe(true);
  });

  it('ctrl：start→ok、pause→unsupported（Windows 无 SIGSTOP）、stop→dispose 清目录', async () => {
    const { mgr, children, firmwarePath } = setup();
    const { sessionId } = await mgr.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' });

    expect(await mgr.ctrl(sessionId, 'start')).toBe('ok');
    expect(await mgr.ctrl(sessionId, 'pause')).toBe('unsupported');

    await mgr.ctrl(sessionId, 'stop');
    expect(mgr.get(sessionId)).toBeNull();
    expect((children[0] as FakeChild).killCalls.length).toBeGreaterThan(0);
  });

  it('端口回收：两个会话不同端口；dispose 后端口可复用', async () => {
    const { mgr, firmwarePath } = setup();
    const a = await mgr.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' });
    const b = await mgr.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' });
    expect(b.port).not.toBe(a.port);

    await mgr.dispose(a.sessionId, 'test');
    const c = await mgr.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' });
    expect(c.port).toBe(a.port);
  });

  it('非正常退出（exit 非 0）→ onExit 回调；dispose 主动退出不触发', async () => {
    const { mgr, children, firmwarePath } = setup();
    const exits: Array<{ sid: string; code: number | null }> = [];
    mgr.onExit((sid, code) => exits.push({ sid, code }));

    const { sessionId } = await mgr.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' });
    (children[0] as FakeChild).emit('exit', 1, null);
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([{ sid: sessionId, code: 1 }]);

    exits.length = 0;
    const s2 = await mgr.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' });
    await mgr.dispose(s2.sessionId, 'test');
    await new Promise((r) => setImmediate(r));
    expect(exits).toHaveLength(0);
  });

  it('空闲回收：sessionTimeoutMs 到期自动 dispose', async () => {
    const { mgr, children, firmwarePath } = setup({ sessionTimeoutMs: 10 });
    const { sessionId } = await mgr.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' });
    await new Promise((r) => setTimeout(r, 40));
    expect(mgr.get(sessionId)).toBeNull();
    expect((children[0] as FakeChild).killCalls.length).toBeGreaterThan(0);
  });

  it('QEMU 未配置（tools.qemuXtensa 为空串）→ 拒绝 spawn', async () => {
    const { mgr, firmwarePath, children } = setup();
    // 直接在 manager 层验证：配置注入空串
    const dir = mkdtempSync(join(tmpdir(), 'esp32sim-qemu-empty-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const base = appConfigSchema.parse({});
    const config: AppConfig = {
      ...base,
      flash: { ...base.flash, dir: join(dir, 'flash') },
      tools: { ...base.tools, qemuXtensa: '', qemuRiscv32: '' },
    };
    const mgrEmpty = new QemuManager({
      config,
      spawn: (_f, a) => new FakeChild(a) as unknown as ChildProcess,
    });
    await expect(
      mgrEmpty.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' }),
    ).rejects.toThrow(/QEMU 未配置/);
    // 主 manager 未受影响（对照）
    void mgr;
    expect(children).toHaveLength(0);
  });

  it('未知 boardType → 拒绝；C3 板卡选 esp32c3 machine（riscv32）', async () => {
    const { mgr, firmwarePath } = setup();
    await expect(mgr.spawnSession({ firmwarePath, boardType: 'no-such-board' })).rejects.toThrow(
      /未知的板卡类型/,
    );

    const { mgr: mgrC3, children } = setup();
    await mgrC3.spawnSession({ firmwarePath, boardType: 'esp32-c3-devkitm-1' });
    const args = (children[0] as FakeChild).args;
    expect(args[args.indexOf('-machine') + 1]).toBe('esp32c3');
  });

  it('connectSerial：连上串口 TCP（M4 串口泵链路基础）', async () => {
    const { mgr, firmwarePath } = setup();
    const { sessionId } = await mgr.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' });

    const sock = await mgr.connectSerial(sessionId);
    expect(sock.remotePort).toBe(mgr.get(sessionId)?.port);
    sock.destroy();
    await mgr.dispose(sessionId, 'test');
  });

  it('M5 GPIO 桥：gpioPort 独立分配、connectGpioSerial 连上第二 serial、dispose 双端口回收', async () => {
    const { mgr, firmwarePath } = setup();
    const { sessionId } = await mgr.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' });
    const info = mgr.get(sessionId);
    expect(info?.gpioPort).toBeGreaterThanOrEqual(40_000);
    expect(info?.gpioPort).toBeLessThanOrEqual(41_000);
    expect(info?.gpioPort).not.toBe(info?.port);

    const sock = await mgr.connectGpioSerial(sessionId);
    expect(sock.remotePort).toBe(info?.gpioPort);
    sock.destroy();

    // dispose 后两个端口都回收：新会话从池头重新分配（可复用旧 gpioPort），且自身两端口互异
    await mgr.dispose(sessionId, 'test');
    const b = await mgr.spawnSession({ firmwarePath, boardType: 'esp32-devkit-c-v4' });
    expect(b.port).not.toBe(b.gpioPort);
    expect(b.port).toBeLessThanOrEqual(info?.port ?? 0);
    await mgr.dispose(b.sessionId, 'test');
  });
});
