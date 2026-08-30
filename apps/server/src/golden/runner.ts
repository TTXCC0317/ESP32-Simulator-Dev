import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AppConfig } from '../config/schema';
import type { Db } from '../db/client';
import { seedExamples } from '../db/seed';
import { createProject } from '../services/projects.service';
import { BuildService, type BuildRunner } from '../services/build.service';
import { pullOfMode, QemuGpioBridge } from '../services/gpio.bridge';
import { QemuManager, type SpawnQemuFn } from '../services/qemu.manager';
import type { GoldenResult, GoldenScript } from './golden-schema';

/**
 * Golden 运行器 v2（02-§3.2/§4 M5：输入序列注入 ×2引擎 + GPIO 输出断言 ×2引擎）
 *
 * - 引擎B：进程内 BuildService 编译示例 → QemuManager spawn → -serial tcp 采集
 *   durationMs → serialCycle 行序列断言（完整循环 ≥2 轮）；GPIO 桥（第二 serial）
 *   观测 GPIO_WRITE 帧计数 + input 序列 GPIO_INPUT 帧注入（release 回退 PIN_MODE pull）；
 * - 引擎A：node 加载 micropython.wasm（apps/web/src/sim/mpy/ 产物）执行 main.py，
 *   machine shim → 串口/GPIO 计数断言；input 序列按 atMs 写注入表（gpioRead 读取 +
 *   mp_js_gpio_inject 沿触发 irq），release 回退 gpioConfigure pull 语义；
 * - GPIO 断言：两引擎启用（M5 起）；产物未入库时返回 skip 引导。
 */

/** 锚定本文件位置（apps/server/src/golden/），不依赖 cwd（vitest 根启动 / server 直启均可） */
const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MPY_WASM_PATH = join(SERVER_DIR, '..', 'web', 'src', 'sim', 'mpy', 'micropython.wasm');

/** 加载 examples/<id>/golden.json（02-§2 目录约定；examples 在仓库根） */
export function loadGoldenScript(exampleId: string): GoldenScript {
  const p = join(SERVER_DIR, '..', '..', 'examples', exampleId, 'golden.json');
  return JSON.parse(readFileSync(p, 'utf8')) as GoldenScript;
}

/** 定制构建 glue 的最小 API 面（v1.26 loadMicroPython，与 web loader.ts 对齐，仅 golden 所需） */
interface MpyApiModule {
  ccall: (
    ident: string,
    returnType: string | null,
    argTypes: string[],
    args: unknown[],
    opts?: { async?: boolean },
  ) => unknown;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  /** GPIO irq 沿注入导出（m5-1 产物；旧产物缺失时轮询式读取兜底） */
  _mp_js_gpio_inject?: (pin: number, level: number) => void;
  /** 键盘中断调度导出：窗口到点后停掉 while True 程序（否则 Asyncify 驱动的
   *  程序在后台空转，饿死同进程引擎B的事件循环定时器——M5 golden 实测） */
  _mp_sched_keyboard_interrupt?: () => void;
  lengthBytesUTF8: (str: string) => number;
  stringToUTF8: (str: string, outPtr: number, maxBytes: number) => void;
}

interface MpyApi {
  _module: MpyApiModule;
}

export interface GoldenAOptions {
  db: Db;
  /** 测试注入：wasm 产物目录（缺省 apps/web/src/sim/mpy/） */
  mpyDir?: string;
}

/**
 * 引擎A（L5 真实路径）：Node 直载 micropython.mjs/wasm → 注册 machine 桥 →
 * 执行 main.py（示例工程 project_files）→ durationMs 窗口采集串行行 + GPIO 翻转计数。
 * 产物未入库时返回引导性失败；断言：serialCycle ≥2 轮 + expect.gpio 计数（02-§3.2）。
 */
export async function runGoldenEngineA(
  script: GoldenScript,
  opts: GoldenAOptions,
): Promise<GoldenResult> {
  const fail = (error: string): GoldenResult => ({
    engine: 'micropython-wasm',
    exampleId: script.exampleId,
    ok: false,
    serialLines: [],
    error,
  });

  // 1) 产物探测（mpyDir 可注入，测试断言"未入库"引导路径）
  const mpyDir = opts.mpyDir ?? dirname(MPY_WASM_PATH);
  const gluePath = join(mpyDir, 'micropython.mjs');
  const wasmPath = join(mpyDir, 'micropython.wasm');
  try {
    readFileSync(wasmPath);
    readFileSync(gluePath);
  } catch {
    return fail(
      '引擎A WASM 产物未入库（apps/web/src/sim/mpy/micropython.{wasm,mjs} 缺失）——先执行 tools/mpy-build 构建',
    );
  }

  // 2) 示例源码（db 驱动：seed → createProject 实例化 → project_files）
  let mainPy: string;
  try {
    seedExamples(opts.db);
    const meta = createProject(opts.db, {
      name: `golden-a-${script.exampleId}`,
      exampleId: script.exampleId,
    });
    const files = opts.db
      .prepare('SELECT path, content FROM project_files WHERE project_id = ?')
      .all(meta.id) as Array<{ path: string; content: string }>;
    const f = files.find((x) => x.path === 'main.py' || x.path === '/main.py');
    if (!f) return fail('示例工程缺少 main.py（project_files 为空）');
    mainPy = f.content;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // 3) 加载 wasm + 注册 machine 桥（machine.c EM_JS → globalThis.__mpyMachine）
  // stdout/stderr：glue linebuffer 已按行回调（无 \n）→ 直接入列；
  // machine UART：原始字节流（可能半行）→ 本地缓冲切行。
  const lines: string[] = [];
  let uartBuf = '';
  const pushUart = (text: string): void => {
    uartBuf += text;
    const parts = uartBuf.split(/\r?\n/);
    uartBuf = parts.pop() ?? '';
    for (const l of parts) if (l.trim()) lines.push(l.trim());
  };
  const pushLine = (text: string): void => {
    if (text.trim()) lines.push(text.trim());
  };
  const gpio = new Map<number, { highs: number; lows: number }>();
  /** input 序列注入表（GPIO → 电平）；release 清除后回退 pull 记录 */
  const injected = new Map<number, 0 | 1>();
  /** Pin(n, Pin.IN, pull) 的 pull 电平记录（gpioConfigure 上报；none→0） */
  const pulls = new Map<number, 0 | 1>();
  /** wasm 导出的 irq 沿注入（mp_js_gpio_inject；旧产物缺省则轮询式读取兜底） */
  let injectHw: ((pin: number, level: number) => void) | null = null;
  const decoder = new TextDecoder();
  (globalThis as unknown as Record<string, unknown>).__mpyMachine = {
    gpioWrite: (pin: number, level: number): void => {
      const c = gpio.get(pin) ?? { highs: 0, lows: 0 };
      if (level) c.highs += 1;
      else c.lows += 1;
      gpio.set(pin, c);
    },
    gpioRead: (pin: number): number => injected.get(pin) ?? pulls.get(pin) ?? 0,
    // Pin(n, Pin.IN, pull) 构造上报（machine.c js_gpio_configure）：记录 pull 电平
    // （up=2→1、down=1/none=0→0，release 回退用，05-§1.4）
    gpioConfigure: (pin: number, mode: number, pull: number): void => {
      if (mode !== 0) return;
      pulls.set(pin, pull === 2 ? 1 : 0);
    },
    uartWrite: (_port: number, bytes: Uint8Array): void => pushUart(decoder.decode(bytes)),
    uartRead: (): Uint8Array | null => null,
    uartAvailable: (): number => 0,
  };

  let mod: MpyApiModule;
  try {
    const glue = (await import(pathToFileURL(gluePath).href)) as {
      loadMicroPython: (opts?: Record<string, unknown>) => Promise<MpyApi>;
    };
    const mp = await glue.loadMicroPython({
      // url 完整替换 glue 的 locateFile → wasm 原生绝对路径（Node fs 直读）
      url: wasmPath,
      stdout: pushLine,
      stderr: pushLine,
    });
    mod = mp._module;
    injectHw = mod._mp_js_gpio_inject ?? null;
  } catch (err) {
    return fail(`wasm 加载失败：${err instanceof Error ? err.message : String(err)}`);
  }

  // 4) 执行 main.py：mp_js_do_exec（v1.26 入口）+ Asyncify 驱动 time.sleep
  //    （while True 挂起运行）；durationMs 窗口到点即返回采集（do_exec Promise 仍在
  //    后台，进程退出即终止）。
  //    input 序列按 atMs 调度（相对执行起点）：注入表 + irq 沿注入（M5 ×引擎A）。
  const timers: NodeJS.Timeout[] = [];
  try {
    for (const ev of script.input ?? []) {
      timers.push(
        setTimeout(
          () => {
            if (ev.release) {
              injected.delete(ev.gpio);
              injectHw?.(ev.gpio, pulls.get(ev.gpio) ?? 0);
            } else {
              injected.set(ev.gpio, ev.level);
              injectHw?.(ev.gpio, ev.level);
            }
          },
          Math.min(ev.atMs, script.durationMs),
        ),
      );
    }
    const len = mod.lengthBytesUTF8(mainPy);
    const buf = mod._malloc(len + 1);
    mod.stringToUTF8(mainPy, buf, len + 1);
    const value = mod._malloc(3 * 4);
    const done = mod.ccall(
      'mp_js_do_exec',
      'number',
      ['pointer', 'number', 'pointer'],
      [buf, len, value],
      { async: true },
    ) as unknown as Promise<number>;
    done.catch(() => {}); // 中断退出路径可能以异常落地，避免 unhandledRejection
    await Promise.race([
      done.then((rc) => {
        mod._free(buf);
        mod._free(value);
        if (rc !== 0) pushLine(`[exit=${rc}]`);
      }),
      // 窗口到点：调度 KeyboardInterrupt 终止 while True 程序（done 随后异步 resolve），
      // 防止 Asyncify 驱动的空转程序饿死后续引擎B的定时器（M5 golden 实测修复）
      new Promise((res) =>
        setTimeout(() => {
          mod._mp_sched_keyboard_interrupt?.();
          res(null);
        }, script.durationMs),
      ),
    ]);
  } catch (err) {
    return fail(`脚本执行失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const t of timers) clearTimeout(t);
  }
  if (uartBuf.trim()) lines.push(uartBuf.trim());

  // 5) 断言：serialCycle ≥2 轮 + gpio 计数（≥ 容差，02-§3.2）
  const serialOk = assertSerialCycle(lines, script.expect.serialCycle, 2);
  let gpioOk = true;
  let gpioDetail = '';
  let gpioActual: GoldenResult['gpio'];
  if (script.expect.gpio) {
    const { pin, highs, lows } = script.expect.gpio;
    const c = gpio.get(pin) ?? { highs: 0, lows: 0 };
    gpioOk = c.highs >= highs && c.lows >= lows;
    gpioActual = { pin, highs: c.highs, lows: c.lows };
    gpioDetail = `；gpio pin${pin}: highs=${c.highs}(≥${highs}) lows=${c.lows}(≥${lows})`;
  }
  const ok = serialOk && gpioOk;
  return {
    engine: 'micropython-wasm',
    exampleId: script.exampleId,
    ok,
    serialLines: lines,
    gpio: gpioActual,
    error: ok
      ? undefined
      : `${serialOk ? '' : `串口输出未出现「${script.expect.serialCycle.join('→')}」完整 2 轮`}${gpioDetail}`,
  };
}

/** GPIO 桥通道（观测固件 GPIO_WRITE/PIN_MODE + 宿主注入）；真实路径由 QemuGpioBridge 适配 */
export interface GoldenGpioChannel {
  onGpioWrite(cb: (pin: number, level: 0 | 1) => void): void;
  onPinMode(cb: (pin: number, mode: number) => void): void;
  injectInput(pin: number, level: 0 | 1): void;
}

export interface GoldenBOptions {
  db: Db;
  config: AppConfig;
  /** 测试注入 stub；缺省用真实 execa runner */
  buildRunner?: BuildRunner;
  /** 测试注入 stub；缺省 spawn 真实 QEMU */
  qemuSpawn?: SpawnQemuFn;
  /** 测试注入：替换 spawn+串口采集（stub 工具链 L1）；真实路径自动使用 */
  serialCollector?: (onLine: (line: string) => void, durationMs: number) => Promise<void>;
  /** 测试注入：替换 GPIO 桥通道（stub L1；真实路径 connectGpioSerial + QemuGpioBridge） */
  gpioChannel?: GoldenGpioChannel;
}

/** 引擎B：编译 → QEMU → GPIO 桥（观测/注入）+ 串口采集 → serialCycle + gpio 断言 */
export async function runGoldenEngineB(
  script: GoldenScript,
  opts: GoldenBOptions,
): Promise<GoldenResult> {
  const { db, config } = opts;
  const fail = (error: string): GoldenResult => ({
    engine: 'qemu-remote',
    exampleId: script.exampleId,
    ok: false,
    serialLines: [],
    error,
  });

  // 1) seed + 从示例 manifest 实例化临时工程（01-§6.1）
  seedExamples(db);
  let projectId: string;
  let boardType: string;
  try {
    const meta = createProject(db, {
      name: `golden-${script.exampleId}`,
      exampleId: script.exampleId,
    });
    projectId = meta.id;
    boardType = meta.boardType.replace(/^board-/, '');
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // 2) 编译（真 runner = execa；测试注入 stub）
  const builds = new BuildService({ db, config, run: opts.buildRunner });
  let buildId: string;
  try {
    ({ buildId } = builds.submit(projectId, 'arduino'));
  } catch (err) {
    return fail(`编译提交失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const rec = await builds.waitForFinish(buildId);
  if (rec.status !== 'success' || !rec.artifact) {
    const tail = (rec.log ?? '').split('\n').slice(-3).join(' | ');
    return fail(`编译未成功（status=${rec.status}）：${tail}`);
  }

  // 3) 运行窗口：GPIO 桥（expect.gpio / input 需要时）+ 串口采集 + input 序列注入
  const lines: string[] = [];
  const gpioCounts = new Map<number, { highs: number; lows: number }>();
  /** 固件 PIN_MODE 上报的 pull 电平（release 回退用，05-§1.4） */
  const pinPull = new Map<number, 0 | 1>();
  const recordWrite = (pin: number, level: 0 | 1): void => {
    const c = gpioCounts.get(pin) ?? { highs: 0, lows: 0 };
    if (level) c.highs += 1;
    else c.lows += 1;
    gpioCounts.set(pin, c);
  };
  const needGpio = script.expect.gpio !== undefined || (script.input?.length ?? 0) > 0;
  const timers: NodeJS.Timeout[] = [];
  /** 统一订阅（真实/stub 通道一致）：GPIO_WRITE 计数 + PIN_MODE pull 记录 */
  const subscribeChannel = (ch: GoldenGpioChannel): void => {
    ch.onGpioWrite(recordWrite);
    ch.onPinMode((pin, mode) => {
      const p = pullOfMode(mode);
      if (p !== null) pinPull.set(pin, p);
    });
  };
  /** input 序列按 atMs 调度（相对窗口起点）：release 回退 PIN_MODE pull（05-§1.4） */
  const scheduleInputs = (ch: GoldenGpioChannel): void => {
    for (const ev of script.input ?? []) {
      timers.push(
        setTimeout(
          () => ch.injectInput(ev.gpio, ev.release ? (pinPull.get(ev.gpio) ?? 0) : ev.level),
          Math.min(ev.atMs, script.durationMs),
        ),
      );
    }
  };
  try {
    let channel: GoldenGpioChannel | null = opts.gpioChannel ?? null;
    if (!opts.serialCollector) {
      const qemu = new QemuManager({ config, spawn: opts.qemuSpawn });
      const { sessionId } = await qemu.spawnSession({
        firmwarePath: join(builds.buildDir(buildId), rec.artifact),
        boardType,
      });
      const serial = await qemu.connectSerial(sessionId);
      // GPIO 桥（第二 serial；M5）：QemuGpioBridge 适配为 GoldenGpioChannel
      if (needGpio && !channel) {
        const sock = await qemu.connectGpioSerial(sessionId);
        const writeSubs = new Set<(pin: number, level: 0 | 1) => void>();
        const modeSubs = new Set<(pin: number, mode: number) => void>();
        const bridge = new QemuGpioBridge(sock, {
          onGpioWrite: (pin, level) => {
            for (const cb of writeSubs) cb(pin, level);
          },
          onPinMode: (pin, mode) => {
            for (const cb of modeSubs) cb(pin, mode);
          },
        });
        channel = {
          onGpioWrite: (cb) => writeSubs.add(cb),
          onPinMode: (cb) => modeSubs.add(cb),
          injectInput: (pin, level) => bridge.injectInput(pin, level),
        };
      }
      if (channel && needGpio) subscribeChannel(channel);
      if (channel) scheduleInputs(channel);
      // 采集窗口内监控 QEMU 退出/串口断开（提前结束 → 根因化报错，而非笼统断言失败）
      const exitInfo = await new Promise<{
        early: boolean;
        detail: string;
      }>((res) => {
        const t0 = Date.now();
        let buf = '';
        let timer: NodeJS.Timeout | null = null;
        const offExit = qemu.onExit((sid, code, signal) => {
          if (sid !== sessionId) return;
          finish(true, `QEMU 进程退出（${Date.now() - t0}ms，code=${code} signal=${signal}）`);
        });
        const finish = (early: boolean, detail: string): void => {
          offExit();
          if (timer) clearTimeout(timer);
          res({ early, detail });
        };
        timer = setTimeout(() => finish(false, ''), script.durationMs);
        serial.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const parts = buf.split(/\r?\n/);
          buf = parts.pop() ?? '';
          for (const l of parts) if (l.trim()) lines.push(l.trim());
        });
        serial.on('error', (err: Error) => {
          finish(true, `串口连接错误（${Date.now() - t0}ms）：${err.message}`);
        });
        serial.on('close', () => {
          finish(true, `串口连接关闭（${Date.now() - t0}ms）`);
        });
      });
      await qemu.dispose(sessionId, 'golden done');
      if (exitInfo.early)
        return fail(`QEMU 运行中断：${exitInfo.detail}（已采集 ${lines.length} 行）`);
    } else {
      if (channel && needGpio) subscribeChannel(channel);
      if (channel) scheduleInputs(channel);
      await opts.serialCollector((l) => lines.push(l), script.durationMs);
    }
  } catch (err) {
    return fail(`QEMU 运行失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const t of timers) clearTimeout(t);
  }

  // 4) 断言：serialCycle ≥2 轮 + gpio 计数（M5 两引擎，02-§3.2）
  const serialOk = assertSerialCycle(lines, script.expect.serialCycle, 2);
  let gpioOk = true;
  let gpioDetail = '';
  let gpioActual: GoldenResult['gpio'];
  if (script.expect.gpio) {
    const { pin, highs, lows } = script.expect.gpio;
    const c = gpioCounts.get(pin) ?? { highs: 0, lows: 0 };
    gpioOk = c.highs >= highs && c.lows >= lows;
    gpioActual = { pin, highs: c.highs, lows: c.lows };
    gpioDetail = `；gpio pin${pin}: highs=${c.highs}(≥${highs}) lows=${c.lows}(≥${lows})`;
  }
  const ok = serialOk && gpioOk;
  return {
    engine: 'qemu-remote',
    exampleId: script.exampleId,
    ok,
    serialLines: lines,
    gpio: gpioActual,
    error: ok
      ? undefined
      : `${serialOk ? '' : `串口输出未出现「${script.expect.serialCycle.join('→')}」完整 2 轮（已采集 ${lines.length} 行）`}${gpioDetail}`,
  };
}

/** 行序列中 cycle 连续循环出现 ≥want 轮（不匹配行=启动日志，跳过） */
export function assertSerialCycle(lines: string[], cycle: string[], want: number): boolean {
  if (cycle.length === 0) return false;
  let idx = 0;
  let rounds = 0;
  let matched = false;
  for (const line of lines) {
    if (line.includes(cycle[idx] as string)) {
      idx += 1;
      matched = true;
      if (idx === cycle.length) {
        rounds += 1;
        idx = 0;
      }
    }
  }
  return matched && rounds >= want;
}
