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

/** 固件 panic 检出（QEMU Espressif fork 双核缓存仿真 flake，触发引擎B 换会话重试，见下） */
const PANIC_RE = /Guru Meditation/i;

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
  /** 各引脚 PWM duty 写入事件计数（M7 pwm-breath 断言） */
  const pwmWrites = new Map<number, number>();
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
    /** PWM(pin, freq, duty) 回调（machine shim js_pwm_write 透传；web engine.ts 已用） */
    pwmWrite: (pin: number, _duty: number, _freq: number): void => {
      pwmWrites.set(pin, (pwmWrites.get(pin) ?? 0) + 1);
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
  /** 各引脚最近一次按下电平（release 回退用：pull 未观测时取按下电平取反） */
  const lastPressA = new Map<number, 0 | 1>();
  try {
    for (const ev of script.input ?? []) {
      timers.push(
        setTimeout(
          () => {
            if (ev.release) {
              injected.delete(ev.gpio);
              // pull 未观测（wasm 启动竞态）时取按下电平取反：上拉对地按下 0→释放 1、
              // 下拉接 VCC 按下 1→释放 0，与 pull 语义一致（M6 golden 慢启动实测修复）
              injectHw?.(
                ev.gpio,
                pulls.get(ev.gpio) ?? ((1 - (lastPressA.get(ev.gpio) ?? 0)) as 0 | 1),
              );
            } else {
              injected.set(ev.gpio, ev.level);
              lastPressA.set(ev.gpio, ev.level);
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

  // 5) 断言：serialCycle ≥2 轮 / serialContainsAll 全匹配 + gpio 计数（含 minPwm，02-§3.2 M7）
  const serialCycleOk =
    script.expect.serialCycle === undefined
      ? true
      : assertSerialCycle(lines, script.expect.serialCycle, 2);
  const serialContainsOk =
    script.expect.serialContainsAll === undefined
      ? true
      : assertSerialContainsAll(lines, script.expect.serialContainsAll);
  const serialOk = serialCycleOk && serialContainsOk;
  let gpioOk = true;
  let gpioDetail = '';
  let gpioActual: GoldenResult['gpio'];
  if (script.expect.gpio) {
    const { pin, highs, lows, minPwm } = script.expect.gpio;
    const c = gpio.get(pin) ?? { highs: 0, lows: 0 };
    const pw = pwmWrites.get(pin) ?? 0;
    const highsOk = highs === undefined ? true : c.highs >= highs;
    const lowsOk = lows === undefined ? true : c.lows >= lows;
    const pwmOk = minPwm === undefined ? true : pw >= minPwm;
    gpioOk = highsOk && lowsOk && pwmOk;
    gpioActual = { pin, highs: c.highs, lows: c.lows, pwmWrites: pw };
    const parts: string[] = [];
    if (highs !== undefined) parts.push(`highs=${c.highs}(≥${highs})`);
    if (lows !== undefined) parts.push(`lows=${c.lows}(≥${lows})`);
    if (minPwm !== undefined) parts.push(`pwmWrites=${pw}(≥${minPwm})`);
    gpioDetail = `；gpio pin${pin}: ${parts.join(' ')}`;
  }
  const ok = serialOk && gpioOk;
  const serialErrors: string[] = [];
  if (!serialCycleOk && script.expect.serialCycle) {
    serialErrors.push(`串口输出未出现「${script.expect.serialCycle.join('→')}」完整 2 轮`);
  }
  if (!serialContainsOk && script.expect.serialContainsAll) {
    const missing = script.expect.serialContainsAll.filter(
      (s) => !lines.some((l) => l.includes(s)),
    );
    serialErrors.push(`串口缺少子串：${missing.join(', ')}（已采集 ${lines.length} 行）`);
  }
  return {
    engine: 'micropython-wasm',
    exampleId: script.exampleId,
    ok,
    serialLines: lines,
    gpio: gpioActual,
    error: ok ? undefined : `${serialErrors.join('；')}${gpioDetail}`,
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
  /** 各引脚 PWM duty 写入事件计数（引擎B：桥 PWM_WRITE 帧，M7 pwm-breath 断言） */
  const pwmCounts = new Map<number, number>();
  /** 固件 PIN_MODE 上报的 pull 电平（release 回退用，05-§1.4） */
  const pinPull = new Map<number, 0 | 1>();
  const recordWrite = (pin: number, level: 0 | 1): void => {
    const c = gpioCounts.get(pin) ?? { highs: 0, lows: 0 };
    if (level) c.highs += 1;
    else c.lows += 1;
    gpioCounts.set(pin, c);
  };
  const recordPwm = (pin: number, _duty: number): void => {
    pwmCounts.set(pin, (pwmCounts.get(pin) ?? 0) + 1);
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
  /** input 序列按 atMs 调度（相对窗口起点）：release 回退 PIN_MODE pull（05-§1.4）；
   *  pull 未观测（QEMU 慢启动，PIN_MODE 上报晚于 release 调度）时取按下电平取反——
   *  上拉对地按下 0→释放 1、下拉接 VCC 按下 1→释放 0，与 pull 语义一致（M6 实测修复） */
  const scheduleInputs = (ch: GoldenGpioChannel): void => {
    const lastPress = new Map<number, 0 | 1>();
    for (const ev of script.input ?? []) {
      timers.push(
        setTimeout(
          () => {
            if (ev.release) {
              ch.injectInput(
                ev.gpio,
                pinPull.get(ev.gpio) ?? ((1 - (lastPress.get(ev.gpio) ?? 0)) as 0 | 1),
              );
            } else {
              lastPress.set(ev.gpio, ev.level);
              ch.injectInput(ev.gpio, ev.level);
            }
          },
          Math.min(ev.atMs, script.durationMs),
        ),
      );
    }
  };
  try {
    let channel: GoldenGpioChannel | null = opts.gpioChannel ?? null;
    if (!opts.serialCollector) {
      const qemu = new QemuManager({ config, spawn: opts.qemuSpawn });
      // 固件 panic 重试（M6 实测）：QEMU Espressif fork 双核缓存仿真存在 flake——
      // 固件启动后首轮循环偶发 "Guru Meditation: Cache error"（双核 IDLE 上下文、
      // EXCVADDR 0x0，与固件内容/输入帧时序无关，同二进制多次复现率 ~50%，
      // addr2line 回溯均落在 esp_cpu_wait_for_intr）。检出即换新 QEMU 会话重试一次，
      // 连续两次 panic 才判失败（06-§3 QEMU 行已记录该 flake 与缓解口径）。
      const MAX_ATTEMPTS = 2;
      let panicked = false;
      let attempt = 0;
      while (true) {
        attempt += 1;
        panicked = false;
        lines.length = 0;
        gpioCounts.clear();
        pwmCounts.clear();
        pinPull.clear();
        for (const t of timers) clearTimeout(t);
        timers.length = 0;

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
            onPwmWrite: (pin, duty) => recordPwm(pin, duty),
            onPwmFreq: () => {
              /* PWM_FREQ 事件当前 golden 未断言，M7 暂不采集 */
            },
          });
          channel = {
            onGpioWrite: (cb) => writeSubs.add(cb),
            onPinMode: (cb) => modeSubs.add(cb),
            injectInput: (pin, level) => bridge.injectInput(pin, level),
          };
        }
        if (channel && needGpio) subscribeChannel(channel);
        // 注入就绪门控：等全部输入脚 PIN_MODE 帧观测到（glue pinMode → br_init → 上报，
        // 即固件已跑 setup、桥 RX 稳态）再按 atMs 相对调度，保证注入帧在固件稳态到达、
        // atMs 语义锚定固件就绪时刻（02-§3.2）；10s 未就绪（剧本无 pinMode）退化为
        // 窗口起点调度。串口数据由 socket 缓冲，采集 handler 后挂不丢帧（paused→flowing）。
        if (channel && (script.input?.length ?? 0) > 0) {
          const pins = [...new Set((script.input ?? []).map((e) => e.gpio))];
          const t0 = Date.now();
          while (pins.some((p) => !pinPull.has(p)) && Date.now() - t0 < 10_000) {
            await new Promise((r) => setTimeout(r, 25));
          }
        }
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
            for (const l of parts)
              if (l.trim()) {
                const line = l.trim();
                lines.push(line);
                if (PANIC_RE.test(line)) {
                  panicked = true;
                  finish(true, `固件 panic：${line}`);
                }
              }
          });
          serial.on('error', (err: Error) => {
            finish(true, `串口连接错误（${Date.now() - t0}ms）：${err.message}`);
          });
          serial.on('close', () => {
            finish(true, `串口连接关闭（${Date.now() - t0}ms）`);
          });
        });
        const retriable = panicked && attempt < MAX_ATTEMPTS;
        await qemu.dispose(sessionId, retriable ? 'golden retry（固件 panic）' : 'golden done');
        if (panicked) {
          if (retriable) continue;
          return fail(
            `固件 panic（重试 ${attempt - 1} 次后仍复现）：${exitInfo.detail}（已采集 ${lines.length} 行）`,
          );
        }
        if (exitInfo.early)
          return fail(`QEMU 运行中断：${exitInfo.detail}（已采集 ${lines.length} 行）`);
        break;
      }
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

  // 4) 断言：serialCycle ≥2 轮 / serialContainsAll 全匹配 + gpio 计数（含 minPwm，M7 02-§3.2）
  const serialCycleOk =
    script.expect.serialCycle === undefined
      ? true
      : assertSerialCycle(lines, script.expect.serialCycle, 2);
  const serialContainsOk =
    script.expect.serialContainsAll === undefined
      ? true
      : assertSerialContainsAll(lines, script.expect.serialContainsAll);
  const serialOk = serialCycleOk && serialContainsOk;
  let gpioOk = true;
  let gpioDetail = '';
  let gpioActual: GoldenResult['gpio'];
  if (script.expect.gpio) {
    const { pin, highs, lows, minPwm } = script.expect.gpio;
    const c = gpioCounts.get(pin) ?? { highs: 0, lows: 0 };
    const pw = pwmCounts.get(pin) ?? 0;
    const highsOk = highs === undefined ? true : c.highs >= highs;
    const lowsOk = lows === undefined ? true : c.lows >= lows;
    const pwmOk = minPwm === undefined ? true : pw >= minPwm;
    gpioOk = highsOk && lowsOk && pwmOk;
    gpioActual = { pin, highs: c.highs, lows: c.lows, pwmWrites: pw };
    const parts: string[] = [];
    if (highs !== undefined) parts.push(`highs=${c.highs}(≥${highs})`);
    if (lows !== undefined) parts.push(`lows=${c.lows}(≥${lows})`);
    if (minPwm !== undefined) parts.push(`pwmWrites=${pw}(≥${minPwm})`);
    gpioDetail = `；gpio pin${pin}: ${parts.join(' ')}`;
  }
  const ok = serialOk && gpioOk;
  const serialErrors: string[] = [];
  if (!serialCycleOk && script.expect.serialCycle) {
    serialErrors.push(
      `串口输出未出现「${script.expect.serialCycle.join('→')}」完整 2 轮（已采集 ${lines.length} 行）`,
    );
  }
  if (!serialContainsOk && script.expect.serialContainsAll) {
    const missing = script.expect.serialContainsAll.filter(
      (s) => !lines.some((l) => l.includes(s)),
    );
    serialErrors.push(`串口缺少子串：${missing.join(', ')}（已采集 ${lines.length} 行）`);
  }
  return {
    engine: 'qemu-remote',
    exampleId: script.exampleId,
    ok,
    serialLines: lines,
    gpio: gpioActual,
    error: ok ? undefined : `${serialErrors.join('；')}${gpioDetail}`,
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

/** 串口行中每个 needles 子串至少出现过一次（任意行、任意顺序，M7 servo-pot 用） */
export function assertSerialContainsAll(lines: string[], needles: string[]): boolean {
  if (needles.length === 0) return true;
  return needles.every((s) => lines.some((l) => l.includes(s)));
}
