import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AppConfig } from '../config/schema';
import type { Db } from '../db/client';
import { seedExamples } from '../db/seed';
import { createProject } from '../services/projects.service';
import { BuildService, type BuildRunner } from '../services/build.service';
import { pullOfMode, QemuGpioBridge } from '../services/gpio.bridge';
import { importCatalog, loadCatalog } from '../services/catalog.service';
import { appRoot } from '../utils/app-root';
import { QemuManager, type SpawnQemuFn } from '../services/qemu.manager';
import type { GoldenI2cTxn, GoldenResult, GoldenScript } from './golden-schema';
import type {
  CircuitDoc,
  DhtDeviceSpec,
  I2cDeviceSpec,
  NeopixelDeviceSpec,
  OledDeviceSpec,
} from '@esp32-sim/shared';

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
  /** M8：引擎A shim 未实现 I2C / sensor → expect.i2c/expect.sensor skip（Task 1 wasm shim 补后启用） */
  let i2cSkipNote = '';
  if (script.expect.i2c !== undefined) {
    i2cSkipNote = `；[i2c skip: engine A shim not implemented]`;
  }
  let sensorSkipNote = '';
  if (script.expect.sensor !== undefined) {
    sensorSkipNote = `；[sensor skip: engine A shim not implemented]`;
  }
  let fbSkipNote = '';
  if (script.expect.fb !== undefined) {
    fbSkipNote = `；[fb skip: engine A shim not implemented]`;
  }
  let neopixelSkipNote = '';
  if (script.expect.neopixel !== undefined) {
    neopixelSkipNote = `；[neopixel skip: engine A shim not implemented]`;
  }
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
    i2cTxns: [],
    sensorActual: [],
    fbActual: [],
    neopixelActual: [],
    error: ok
      ? undefined
      : `${serialErrors.join('；')}${gpioDetail}${i2cSkipNote}${sensorSkipNote}${fbSkipNote}${neopixelSkipNote}`,
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
  // catalog 导入（幂等）：M8/M9 设备表（i2cDevices/oledDevices/neopixelPins…）与
  // board_pinmaps（resolveGpio）都读 parts_catalog——CLI/探针内存库不走 app.ts 启动流程，
  // 不导入则设备表恒空、FB/NeoPixel 帧被静默丢弃（M9 探针实测 fb collected=0）。
  importCatalog(db, loadCatalog(join(appRoot(), 'config')));
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

  // M8：从 project diagram 构造 I2C / DHT22 设备表（供 bridge onI2cTxn/onDhtTxn reply 用）
  // M9：追加 OLED（addr→partId，attrs.i2cAddr 可覆盖）与 NeoPixel（gpio→partId）设备表
  const i2cDevices = new Map<number, I2cDeviceSpec>();
  const dhtDevices = new Map<number, { partId: string; temp: number; humidity: number }>();
  const oledDevices = new Map<number, string>();
  const neopixelPins = new Map<number, string>();
  {
    const row = db.prepare('SELECT diagram FROM projects WHERE id = ?').get(projectId) as
      { diagram: string } | undefined;
    let circuit: CircuitDoc;
    if (row) {
      try {
        circuit = JSON.parse(row.diagram) as CircuitDoc;
      } catch {
        circuit = {
          formatVersion: 1,
          boardType: 'board-esp32-devkit-c-v4',
          parts: [],
          connections: [],
          serialMonitor: { baudrate: 115200 },
        };
      }
    } else {
      circuit = {
        formatVersion: 1,
        boardType: 'board-esp32-devkit-c-v4',
        parts: [],
        connections: [],
        serialMonitor: { baudrate: 115200 },
      };
    }

    // adjacency + resolveGpio（从 ws-gateway 同逻辑复制，runner 无路由依赖）
    const boardPartId = circuit.parts.find((p) => p.type === `board-${boardType}`)?.id ?? null;
    const gpioOfStmt = db.prepare(
      'SELECT gpio_no FROM board_pinmaps WHERE board_type = ? AND pin_name = ?',
    );
    const gpioOf = (pName: string): number | null => {
      const r = gpioOfStmt.get(boardType, pName) as { gpio_no: number } | undefined;
      return r?.gpio_no ?? null;
    };
    const adj = new Map<string, string[]>();
    for (const c of circuit.connections) {
      // PinRef = `${partId}:${pin}` —— 已经是完整字符串
      const s = c.source;
      const t = c.target;
      if (!adj.has(s)) adj.set(s, []);
      if (!adj.has(t)) adj.set(t, []);
      adj.get(s)?.push(t);
      adj.get(t)?.push(s);
    }
    const resolveGpioLocal = (partId: string, pinName: string): number | null => {
      if (!boardPartId) return null;
      if (partId === boardPartId) return gpioOf(pinName);
      const start = `${partId}:${pinName}`;
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const cur = queue.shift() as string;
        for (const nxt of adj.get(cur) ?? []) {
          if (seen.has(nxt)) continue;
          seen.add(nxt);
          const idx = nxt.indexOf(':');
          if (nxt.slice(0, idx) === boardPartId) {
            return gpioOf(nxt.slice(idx + 1));
          }
          queue.push(nxt);
        }
      }
      return null;
    };

    const stmt = db.prepare('SELECT definition_json FROM parts_catalog WHERE type = ?');
    for (const part of circuit.parts) {
      const crow = stmt.get(part.type) as { definition_json: string } | undefined;
      if (!crow) continue;
      let def: { simulator?: { device?: unknown }; pins?: { name: string; role?: string }[] };
      try {
        def = JSON.parse(crow.definition_json) as typeof def;
      } catch {
        continue;
      }
      const dev = def.simulator?.device;
      if (!dev) continue;
      if ((dev as I2cDeviceSpec).kind === 'i2c-device') {
        const d = dev as I2cDeviceSpec;
        i2cDevices.set(d.address, d);
      } else if ((dev as DhtDeviceSpec).kind === 'env-sensor') {
        const d = dev as DhtDeviceSpec;
        const signalPinName = def.pins?.find((p) => p.role === 'signal.io')?.name;
        if (!signalPinName) continue;
        const gpio = resolveGpioLocal(part.id, signalPinName);
        if (gpio === null) continue;
        const temp =
          typeof part.attrs.temperature === 'number'
            ? (part.attrs.temperature as number)
            : (d.defaults?.temperature ?? 22);
        const humidity =
          typeof part.attrs.humidity === 'number'
            ? (part.attrs.humidity as number)
            : (d.defaults?.humidity ?? 50);
        dhtDevices.set(gpio, { partId: part.id, temp, humidity });
      } else if ((dev as OledDeviceSpec).kind === 'oled-device') {
        const d = dev as OledDeviceSpec;
        const attr = part.attrs['i2cAddr'];
        const addr =
          typeof attr === 'string' && attr.startsWith('0x') ? parseInt(attr, 16) : d.address;
        oledDevices.set(addr, part.id);
      } else if ((dev as NeopixelDeviceSpec).kind === 'neopixel-device') {
        const signalPinName = def.pins?.find((p) => p.role === 'signal.io')?.name;
        if (!signalPinName) continue;
        const gpio = resolveGpioLocal(part.id, signalPinName);
        if (gpio === null) continue;
        neopixelPins.set(gpio, part.id);
      }
    }
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
    const tail = (rec.log ?? '').split('\n').slice(-40).join(' | ');
    return fail(`编译未成功（status=${rec.status}）：${tail}`);
  }

  // 3) 运行窗口：GPIO 桥（expect.gpio / input 需要时）+ 串口采集 + input 序列注入
  const lines: string[] = [];
  const gpioCounts = new Map<number, { highs: number; lows: number }>();
  /** 各引脚 PWM duty 写入事件计数（引擎B：桥 PWM_WRITE 帧，M7 pwm-breath 断言） */
  const pwmCounts = new Map<number, number>();
  /** 固件 PIN_MODE 上报的 pull 电平（release 回退用，05-§1.4） */
  const pinPull = new Map<number, 0 | 1>();
  /** M8：收集到的 I2C 事务序列（桥 I2C_TXN 帧 → expect.i2c 断言） */
  const i2cTxns: GoldenI2cTxn[] = [];
  /** M8 后续：收集到的 DHT22 读数（桥 DHT22_TXN 帧 → expect.sensor 断言） */
  const sensorData: GoldenResult['sensorActual'] = [];
  /** M9：SSD1306 全帧重组（partId → 1024B 页主序 fb，收到过 ≥1 段才入表） */
  const fbFrames = new Map<string, Uint8Array>();
  /** M9：NeoPixel 写入计数 + 最后帧 RGB 字节（partId → 记录） */
  const neopixelWrites = new Map<string, { writes: number; last: Uint8Array }>();
  const recordWrite = (pin: number, level: 0 | 1): void => {
    const c = gpioCounts.get(pin) ?? { highs: 0, lows: 0 };
    if (level) c.highs += 1;
    else c.lows += 1;
    gpioCounts.set(pin, c);
  };
  const recordPwm = (pin: number, _duty: number): void => {
    pwmCounts.set(pin, (pwmCounts.get(pin) ?? 0) + 1);
  };
  /** 桥需求门控：GPIO 断言/输入注入之外，I2C/SPI/DHT/FB/NeoPixel 帧采集也需第二 serial 桥
   *  （M8 实测缺口：i2c-sensor 无 input/gpio 时桥不创建 → i2cTxns 恒空，真实路径断言必败） */
  const needBridge =
    script.expect.gpio !== undefined ||
    (script.input?.length ?? 0) > 0 ||
    script.expect.i2c !== undefined ||
    script.expect.sensor !== undefined ||
    script.expect.fb !== undefined ||
    script.expect.neopixel !== undefined;
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
        i2cTxns.length = 0;
        sensorData.length = 0;
        fbFrames.clear();
        neopixelWrites.clear();
        for (const t of timers) clearTimeout(t);
        timers.length = 0;

        const { sessionId } = await qemu.spawnSession({
          firmwarePath: join(builds.buildDir(buildId), rec.artifact),
          boardType,
        });
        const serial = await qemu.connectSerial(sessionId);
        // GPIO 桥（第二 serial；M5）：QemuGpioBridge 适配为 GoldenGpioChannel
        if (needBridge && !channel) {
          const sock = await qemu.connectGpioSerial(sessionId);
          const writeSubs = new Set<(pin: number, level: 0 | 1) => void>();
          const modeSubs = new Set<(pin: number, mode: number) => void>();
          /** bridge 实例：onI2cTxn 回调需发送 SENSOR_REPLY，构造后赋值（definite assignment） */
          let bridge!: QemuGpioBridge;
          bridge = new QemuGpioBridge(sock, {
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
            /** M8：收集 I2C_TXN 帧序列供 expect.i2c 断言 + 发 SENSOR_REPLY reply 防固件卡死 */
            onI2cTxn: (ev) => {
              i2cTxns.push({
                addr: ev.addr,
                dir: ev.dir,
                data: Array.from(ev.data),
              });
              // dir=r 时 compute reply → SENSOR_REPLY 帧；dir=w 不需要 reply
              if (ev.dir === 'r') {
                const device = i2cDevices.get(ev.addr);
                const reply = computeI2cReply(device, ev.data);
                bridge.sendI2cReply(ev.addr, reply);
              }
            },
            /** M8 后续：DHT22 单总线请求 —— 查 dhtDevices 回复 DHT22_REPLY + 收集数据 */
            onDhtTxn: (ev) => {
              const device = dhtDevices.get(ev.pin);
              if (device) {
                sensorData.push({
                  partId: device.partId,
                  data: { temperature: device.temp, humidity: device.humidity },
                  gpio: ev.pin,
                });
                const tempRaw = Math.round(device.temp * 10);
                const humRaw = Math.round(device.humidity * 10);
                bridge.sendDhtReply(ev.pin, tempRaw, humRaw);
              } else {
                bridge.sendDhtReply(ev.pin, 0, 0);
              }
            },
            /** M9：FB_TXN 增量段 → partId 路由 + 全帧重组（与前端 applyFb 同页主序布局） */
            onFbTxn: (ev) => {
              const partId = oledDevices.get(ev.addr);
              if (!partId) return;
              let fb = fbFrames.get(partId);
              if (!fb) {
                fb = new Uint8Array(1024); // SSD1306_COLS(128) × SSD1306_PAGES(8)
                fbFrames.set(partId, fb);
              }
              const pageRows = Math.max(1, Math.floor(ev.h / 8));
              for (let i = 0; i < ev.w; i++) {
                for (let j = 0; j < pageRows; j++) {
                  const src = ev.data[j * ev.w + i] ?? 0;
                  const col = ev.x + i;
                  const page = Math.floor(ev.y / 8) + j;
                  if (col >= 0 && col < 128 && page >= 0 && page < 8) fb[page * 128 + col] = src;
                }
              }
            },
            /** M9：NEOPIXEL_WRITE 帧 → partId 路由 + GRB→RGB 归一 + 计数/最后帧 */
            onNeopixelWrite: (ev) => {
              const partId = neopixelPins.get(ev.pin);
              if (!partId) return;
              const rec = neopixelWrites.get(partId) ?? { writes: 0, last: new Uint8Array(0) };
              rec.writes += 1;
              const rgb = new Uint8Array(Math.floor(ev.data.length / 3) * 3);
              for (let i = 0; i + 2 < ev.data.length; i += 3) {
                rgb[i] = ev.data[i + 1] ?? 0; // G
                rgb[i + 1] = ev.data[i] ?? 0; // R
                rgb[i + 2] = ev.data[i + 2] ?? 0; // B
              }
              rec.last = rgb;
              neopixelWrites.set(partId, rec);
            },
          });
          channel = {
            onGpioWrite: (cb) => writeSubs.add(cb),
            onPinMode: (cb) => modeSubs.add(cb),
            injectInput: (pin, level) => bridge.injectInput(pin, level),
          };
        }
        if (channel && needBridge) subscribeChannel(channel);
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
      if (channel && needBridge) subscribeChannel(channel);
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
  /** M8：I2C 事务前缀匹配断言（可选） */
  let i2cOk = true;
  let i2cDetail = '';
  if (script.expect.i2c !== undefined) {
    i2cOk = assertI2cPrefix(i2cTxns, script.expect.i2c);
    i2cDetail = `；i2c collected=${i2cTxns.length} expect=${script.expect.i2c.length}`;
  }
  /** M8 后续：环境传感器读数断言（可选） */
  let sensorOk = true;
  let sensorDetail = '';
  if (script.expect.sensor !== undefined) {
    sensorOk = assertSensorData(sensorData, script.expect.sensor);
    sensorDetail = `；sensor collected=${sensorData.length} expect=${script.expect.sensor.length}`;
  }
  /** M9：实际值组装——FB 全帧 sha256 + NeoPixel 计数/最后帧 sha256 */
  const fbActual: GoldenResult['fbActual'] = [...fbFrames.entries()].map(([partId, fb]) => ({
    partId,
    hash: sha256Hex(fb),
  }));
  const neopixelActual: GoldenResult['neopixelActual'] = [...neopixelWrites.entries()].map(
    ([partId, r]) => ({ partId, writes: r.writes, lastHash: sha256Hex(r.last) }),
  );
  let fbOk = true;
  let fbDetail = '';
  if (script.expect.fb !== undefined) {
    fbOk = assertFbHash(fbActual, script.expect.fb);
    fbDetail = `；fb collected=${fbActual.length} expect=${script.expect.fb.length}`;
  }
  let neopixelOk = true;
  let neopixelDetail = '';
  if (script.expect.neopixel !== undefined) {
    neopixelOk = assertNeopixel(neopixelActual, script.expect.neopixel);
    neopixelDetail = `；neopixel collected=${neopixelActual.length} expect=${script.expect.neopixel.length}`;
  }
  const finalOk = ok && i2cOk && sensorOk && fbOk && neopixelOk;
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
  if (!i2cOk && script.expect.i2c) {
    serialErrors.push(
      `I2C 事务前缀不匹配（收集 ${i2cTxns.length} 条，期望 ${script.expect.i2c.length} 条）`,
    );
  }
  if (!sensorOk && script.expect.sensor) {
    serialErrors.push(
      `环境传感器读数不匹配（收集 ${sensorData.length} 条，期望 ${script.expect.sensor.length} 条）`,
    );
  }
  if (!fbOk && script.expect.fb) {
    serialErrors.push(
      `SSD1306 全帧哈希不匹配（收集 ${fbActual.length} 屏，期望 ${script.expect.fb.length} 屏）`,
    );
  }
  if (!neopixelOk && script.expect.neopixel) {
    serialErrors.push(
      `NeoPixel 断言不匹配（收集 ${neopixelActual.length} 条，期望 ${script.expect.neopixel.length} 条）`,
    );
  }
  return {
    engine: 'qemu-remote',
    exampleId: script.exampleId,
    ok: finalOk,
    serialLines: lines,
    gpio: gpioActual,
    i2cTxns,
    sensorActual: sensorData,
    fbActual,
    neopixelActual,
    error: finalOk
      ? undefined
      : `${serialErrors.join('；')}${gpioDetail}${i2cDetail}${sensorDetail}${fbDetail}${neopixelDetail}`,
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

/**
 * M8：I2C 事务序列前缀匹配
 * expect 序列必须是 collected 序列的前缀（按序、逐字段相等）。
 * - addr / dir 严格匹配
 * - w 事务：expect.data 严格匹配 collected.data（字节序列相等）
 * - r 事务：expect.data 可选（不填则只匹配 addr+dir）
 *
 * 前缀语义：durationMs 窗口收集到的事务可能还没跑完 expect 全部——只要 expect 前 N 个在收集序列里按序出现即可。
 */
export function assertI2cPrefix(
  collected: GoldenI2cTxn[],
  expect: NonNullable<GoldenScript['expect']['i2c']>,
): boolean {
  if (expect.length === 0) return true;
  if (collected.length < expect.length) return false;
  for (let i = 0; i < expect.length; i++) {
    const e = expect[i];
    const a = collected[i];
    if (!e || !a) return false;
    if (e.addr !== a.addr || e.dir !== a.dir) return false;
    if (e.dir === 'w' && e.data) {
      if (a.data.length !== e.data.length) return false;
      for (let j = 0; j < e.data.length; j++) if (a.data[j] !== e.data[j]) return false;
    }
  }
  return true;
}

/**
 * M8 后续：环境传感器读数断言
 * collected 是 sensor.data 事件数组（每次 DHT22 请求都产生一条）
 * expect 是期望的传感器配置（partId + data key-value + tolerance）
 * 匹配逻辑：按 partId 找到对应 collected 条目，data 里每个 key 的值在 tolerance 内。
 * 前缀匹配：只要 collected 至少包含 expect 所有 partId 的读数即可（不要求次数/顺序）。
 */
export function assertSensorData(
  collected: NonNullable<GoldenResult['sensorActual']>,
  expect: NonNullable<GoldenScript['expect']['sensor']>,
): boolean {
  if (expect.length === 0) return true;
  for (const e of expect) {
    // 找 collected 中 partId 匹配的任意一条（取首次出现）
    const match = collected.find((c) => c.partId === e.partId);
    if (!match) return false;
    const tolerance = e.tolerance ?? 0.5;
    for (const [key, want] of Object.entries(e.data)) {
      const got = match.data[key];
      if (got === undefined) return false;
      if (Math.abs(got - want) > tolerance) return false;
    }
  }
  return true;
}

/**
 * M8：I2C 回复计算（与 ws-gateway 同逻辑；runner bridge reply 用）
 * device 按 wdata[0]（寄存器/命令字节）查 registers，返回 defaultBytes 或 0 填充。
 */
function computeI2cReply(device: I2cDeviceSpec | undefined, wdata: Uint8Array): Uint8Array {
  if (!device) return new Uint8Array(0);
  const regAddr = wdata[0];
  const reg = regAddr === undefined ? undefined : device.registers.find((r) => r.addr === regAddr);
  if (!reg) return new Uint8Array(0);
  const size = Math.min(reg.size, 255);
  if (reg.defaultBytes && reg.defaultBytes.length >= size) {
    return new Uint8Array(reg.defaultBytes.slice(0, size));
  }
  return new Uint8Array(size);
}

/** M9：字节序列 sha256 hex（小写） */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * M9：SSD1306 全帧哈希断言
 * 按 partId 匹配实际重组帧的 sha256（引擎A 无 FB 上报 → fbActual 空 → 必败，调用侧已 skip）。
 */
export function assertFbHash(
  actual: NonNullable<GoldenResult['fbActual']>,
  expect: NonNullable<GoldenScript['expect']['fb']>,
): boolean {
  if (expect.length === 0) return true;
  for (const e of expect) {
    const a = actual.find((x) => x.partId === e.partId);
    if (!a || a.hash !== e.hash) return false;
  }
  return true;
}

/**
 * M9：NeoPixel 断言——minWrites（写入计数下限）+ lastHash（最后帧 RGB sha256 相等）。
 * lastHash 缺省时只断言计数；minWrites 缺省时只断言最后帧。
 */
export function assertNeopixel(
  actual: NonNullable<GoldenResult['neopixelActual']>,
  expect: NonNullable<GoldenScript['expect']['neopixel']>,
): boolean {
  if (expect.length === 0) return true;
  for (const e of expect) {
    const a = actual.find((x) => x.partId === e.partId);
    if (!a) return false;
    if (e.minWrites !== undefined && a.writes < e.minWrites) return false;
    if (e.lastHash !== undefined && a.lastHash !== e.lastHash) return false;
  }
  return true;
}
