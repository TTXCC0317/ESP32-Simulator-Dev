import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/schema';
import { appRoot } from '../utils/app-root';

/**
 * QemuManager（03-§7.2）：QEMU 会话生命周期
 *
 * - spawn 参数数组化（06-§6 禁止 shell 拼接），N17 参数表（M4 串口级闭环，无 GPIO 桥）；
 * - 串口走 `-serial tcp:127.0.0.1:<port>,server,nowait`（QEMU 监听，后端 connect 后双向泵）；
 * - 端口池 40000–41000，占用探测 + 会话内去重；
 * - 空闲回收 config.flash.sessionTimeoutMs（默认 30min，06-§4）；
 * - dispose：kill → 5s 兜底 SIGKILL → 清会话目录（进程表无孤儿）。
 *
 * M4 限制（文档同步）：ctrl pause 在 Windows 无 SIGSTOP 语义，网关层返回 error.ack；
 * reset 由网关层 dispose + 重新 spawn 实现。
 */

export type QemuSessionState = 'starting' | 'running' | 'stopping' | 'dead';

export interface QemuSessionInfo {
  sessionId: string;
  pid: number | null;
  /** UART0（串口监视器通道） */
  port: number;
  /** UART1（GPIO 桥通道，M5；桥关闭/不可用时仍分配但可无连接） */
  gpioPort: number;
  state: QemuSessionState;
  boardType: string;
  lastActiveAt: number;
}

export type CtrlCmd = 'start' | 'pause' | 'reset' | 'stop';
export type CtrlResult = 'ok' | 'unsupported' | 'respawn';

/** boardType → QEMU 目标（N17：xtensa / riscv32；M5 按 Espressif fork 实测修正） */
const BOARD_MACHINE: Record<string, { machine: string; qemu: 'xtensa' | 'riscv32'; cpu: string }> =
  {
    'esp32-devkit-c-v4': { machine: 'esp32', qemu: 'xtensa', cpu: 'esp32' },
    'esp32-s3-devkitc-1': { machine: 'esp32s3', qemu: 'xtensa', cpu: 'esp32s3' },
    'esp32-c3-devkitm-1': { machine: 'esp32c3', qemu: 'riscv32', cpu: 'riscv32' },
  };

const PORT_RANGE_START = 40_000;
const PORT_RANGE_END = 41_000;
const KILL_GRACE_MS = 5_000;
const SERIAL_CONNECT_TIMEOUT_MS = 3_000;

export type SpawnQemuFn = (file: string, args: string[]) => ChildProcess;

interface Session {
  info: QemuSessionInfo;
  child: ChildProcess;
  dir: string;
  idleTimer: NodeJS.Timeout;
  /** dispose 主动回收时置位，exit 回调据此跳过 error 上报 */
  stopping: boolean;
}

export class QemuManager {
  private readonly config: AppConfig;
  private readonly spawnFn: SpawnQemuFn;
  private readonly now: () => number;
  private readonly sessions = new Map<string, Session>();
  private readonly usedPorts = new Set<number>();
  private readonly exitListeners = new Set<
    (sessionId: string, code: number | null, signal: string | null) => void
  >();

  constructor(deps: { config: AppConfig; spawn?: SpawnQemuFn; now?: () => number }) {
    this.config = deps.config;
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.now = deps.now ?? Date.now;
  }

  /** 启动时残留清理（06-§4）：删除 flash 目录下 mtime 早于 cleanupOrphanedAfterHours 的会话目录 */
  cleanupOrphanedDirs(): number {
    const root = resolve(process.cwd(), this.config.flash.dir);
    if (!existsSync(root)) return 0;
    const cutoff = Date.now() - this.config.flash.cleanupOrphanedAfterHours * 3_600_000;
    let removed = 0;
    for (const name of readdirSync(root)) {
      if (!name.startsWith('ses-')) continue; // 仅清理会话目录（防御误删）
      const dir = join(root, name);
      try {
        const st = statSync(dir);
        if (!st.isDirectory() || st.mtimeMs >= cutoff) continue;
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // 单个目录失败不影响其余（下次启动重试）
      }
    }
    return removed;
  }

  /** QEMU 进程退出通知（非 dispose 主动退出 → 网关转 state error） */
  onExit(cb: (sessionId: string, code: number | null, signal: string | null) => void): () => void {
    this.exitListeners.add(cb);
    return () => {
      this.exitListeners.delete(cb);
    };
  }

  /** 启动会话：拷贝 flash.img → 分配端口 → spawn QEMU → 空闲定时器 */
  async spawnSession(p: { firmwarePath: string; boardType: string }): Promise<{
    sessionId: string;
    port: number;
    /** GPIO 桥通道端口（第二 serial，UART1；M5） */
    gpioPort: number;
  }> {
    if (this.sessions.size >= this.config.ws.maxConcurrentSessions) {
      throw new Error(
        `并发会话已达上限（${this.config.ws.maxConcurrentSessions}），请先停止其他仿真会话`,
      );
    }
    // CircuitDoc.boardType 带 board- 前缀（01-§7.4.1 N4，前端 session.start 直传），
    // projects.board_type 为短名——查表统一去前缀兼容两种 ID
    const target = BOARD_MACHINE[p.boardType.replace(/^board-/, '')];
    if (!target) throw new Error(`未知的板卡类型：${p.boardType}`);

    const sessionId = `ses-${randomUUID().slice(0, 12)}`;
    const dir = resolve(process.cwd(), this.config.flash.dir, sessionId);
    mkdirSync(dir, { recursive: true });
    cpSync(p.firmwarePath, join(dir, 'flash.img'));

    // 两次分配之间立即占位，避免同一端口被分配两次（UART0 与 GPIO 桥通道互异）
    const port = await this.allocPort();
    this.usedPorts.add(port);
    const gpioPort = await this.allocPort();
    this.usedPorts.add(gpioPort);
    const qemuBin =
      target.qemu === 'xtensa' ? this.config.tools.qemuXtensa : this.config.tools.qemuRiscv32;
    if (!qemuBin) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(
        `QEMU 未配置（tools.qemu${target.qemu === 'xtensa' ? 'Xtensa' : 'Riscv32'} 为空），请安装后更新 config/app.json`,
      );
    }
    // tools 相对路径锚定仓库根（.tools/ 随仓库分发；pnpm --filter 启动时 cwd=apps/server）
    const qemuExe = resolve(appRoot(), qemuBin);

    // N17 参数表（M5：第二 serial = UART1 GPIO 桥通道；-S 不用：attach 即运行）
    const args = [
      '-machine',
      target.machine,
      '-drive',
      // format=raw：消除 QEMU 对裸镜像的探测警告与 block0 写限制
      `file=${join(dir, 'flash.img')},if=mtd,format=raw`,
      '-serial',
      `tcp:127.0.0.1:${port},server,nowait`,
      '-serial',
      `tcp:127.0.0.1:${gpioPort},server,nowait`,
      '-monitor',
      'none',
      '-nographic',
      '-m',
      '4',
      '-cpu',
      target.cpu,
    ];
    const child = this.spawnFn(qemuExe, args);

    const session: Session = {
      info: {
        sessionId,
        pid: child.pid ?? null,
        port,
        gpioPort,
        state: 'starting',
        boardType: p.boardType,
        lastActiveAt: this.now(),
      },
      child,
      dir,
      idleTimer: this.resetIdleTimer(sessionId),
      stopping: false,
    };
    this.sessions.set(sessionId, session);

    child.once('exit', (code, signal) => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      clearTimeout(s.idleTimer);
      s.info.state = 'dead';
      this.usedPorts.delete(s.info.port);
      this.usedPorts.delete(s.info.gpioPort);
      if (!s.stopping) {
        for (const cb of this.exitListeners) cb(sessionId, code, signal);
      }
      // dead 会话保留条目供查询，目录由 dispose 清
    });

    // spawn 即视为 running（N17：attach 后立即运行，无 -S 暂停）
    session.info.state = 'running';

    return { sessionId, port, gpioPort };
  }

  get(sessionId: string): QemuSessionInfo | null {
    return this.sessions.get(sessionId)?.info ?? null;
  }

  list(): QemuSessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }));
  }

  /** 刷新空闲计时（收到 input.uart / ctrl 时调用） */
  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.info.lastActiveAt = this.now();
    clearTimeout(s.idleTimer);
    s.idleTimer = this.resetIdleTimer(sessionId);
  }

  /** 连接串口 TCP（QEMU server 模式就绪重试，3s 超时） */
  async connectSerial(sessionId: string): Promise<net.Socket> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在：${sessionId}`);
    const deadline = Date.now() + SERIAL_CONNECT_TIMEOUT_MS;
    for (;;) {
      try {
        return await this.tryConnect(s.info.port);
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(
            `QEMU 串口连接失败（port ${s.info.port}）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  /** 连接 GPIO 桥通道（第二 serial，UART1；重试语义同 connectSerial） */
  async connectGpioSerial(sessionId: string): Promise<net.Socket> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在：${sessionId}`);
    const deadline = Date.now() + SERIAL_CONNECT_TIMEOUT_MS;
    for (;;) {
      try {
        return await this.tryConnect(s.info.gpioPort);
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(
            `QEMU GPIO 桥连接失败（port ${s.info.gpioPort}）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  /**
   * 会话控制（网关层语义映射）：
   * start → ok（attach 即运行，幂等）；pause → unsupported（Windows 无 SIGSTOP）；
   * reset → respawn（网关 dispose + 重新 spawn）；stop → ok（内部直接 dispose）。
   */
  async ctrl(sessionId: string, cmd: CtrlCmd): Promise<CtrlResult> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在：${sessionId}`);
    this.touch(sessionId);
    switch (cmd) {
      case 'start':
        return 'ok';
      case 'pause':
        return 'unsupported';
      case 'reset':
        return 'respawn';
      case 'stop':
        await this.dispose(sessionId, 'ctrl stop');
        return 'ok';
    }
  }

  /** 终止 + 清目录（SIGTERM → 5s → SIGKILL；Windows 下 kill 即强杀） */
  async dispose(sessionId: string, reason: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.info.state === 'stopping') return;
    s.info.state = 'stopping';
    s.stopping = true;
    clearTimeout(s.idleTimer);

    const child = s.child;
    const exited = new Promise<void>((res) => {
      if (child.exitCode !== null || child.signalCode !== null) res();
      else child.once('exit', () => res());
    });

    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const killer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      killer.unref?.();
    }
    await exited;

    s.info.state = 'dead';
    this.usedPorts.delete(s.info.port);
    this.usedPorts.delete(s.info.gpioPort);
    rmSync(s.dir, { recursive: true, force: true });
    this.sessions.delete(sessionId);
    void reason; // 日志由调用方记录
  }

  /** 进程退出兜底：清掉所有存活会话（index.ts graceful shutdown 用） */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.dispose(id, 'shutdown')));
  }

  // ---- 内部 ----

  private resetIdleTimer(sessionId: string): NodeJS.Timeout {
    const t = setTimeout(() => {
      void this.dispose(sessionId, 'idle-timeout');
    }, this.config.flash.sessionTimeoutMs);
    t.unref?.();
    return t;
  }

  private async allocPort(): Promise<number> {
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
      if (this.usedPorts.has(p)) continue;
      if (await isPortFree(p)) return p;
    }
    throw new Error(`端口池耗尽（${PORT_RANGE_START}-${PORT_RANGE_END}）`);
  }

  private tryConnect(port: number): Promise<net.Socket> {
    return new Promise((res, rej) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      const to = setTimeout(() => {
        sock.destroy();
        rej(new Error('connect timeout'));
      }, 500);
      sock.once('connect', () => {
        clearTimeout(to);
        res(sock);
      });
      sock.once('error', (err) => {
        clearTimeout(to);
        sock.destroy();
        rej(err);
      });
    });
  }
}

function defaultSpawn(file: string, args: string[]): ChildProcess {
  // stdio ignore：stdout 会混入 QEMU 日志噪声；串口数据走 TCP
  return spawn(file, args, { stdio: 'ignore' });
}

/** 端口空闲探测：试绑定 127.0.0.1:port */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => {
      srv.close(() => res(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}
