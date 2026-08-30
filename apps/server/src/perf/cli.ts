import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../config/loader';
import { openDatabase, type Db } from '../db/client';
import { runMigrations } from '../db/migrator';
import { createProject } from '../services/projects.service';
import { BuildService } from '../services/build.service';
import { QemuManager } from '../services/qemu.manager';
import type { AppConfig } from '../config/schema';

/**
 * 性能复核 CLI（02-§3.5 性能验收指标，M6 m6-4）：
 *   pnpm perf [--suite serial|concurrent|enginea|all] [--seconds 10] [--minutes 30] [--out <file>]
 *
 * 覆盖（无头可测三项）：
 * - serial     串口 115200 满速打印无丢行（N:<seq> 严格连续）；
 * - concurrent 4 并发会话稳定运行 --minutes 分钟，各会话流仅含自身标记（零互窜）+ 序号连续；
 * - enginea    引擎A GPIO 突发 8 边沿同步投递延迟 ≤50ms（wasm Node 直载；持续吞吐
 *              受 wasm 产物稳定性限制未测——详见套件注释，S2 遗留项。浏览器侧另有
 *              16ms 批量聚合——N22，仍在 50ms 预算内）。
 * 帧率（≥30fps）与生产构建首屏（≤3s）需真实浏览器，由 Playwright E2E（m6-5）覆盖。
 *
 * 退出码：任一项 fail → 1（CI 阻塞）；--out 同步落盘（Trae/CI stdout 截断防护）。
 */

interface Args {
  suite: 'serial' | 'concurrent' | 'enginea' | 'all';
  seconds: number;
  minutes: number;
  out?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: number): number => {
    const i = argv.indexOf(flag);
    const v = i >= 0 ? Number(argv[i + 1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  const getStr = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : def;
  };
  const suite = getStr('--suite', 'all');
  if (suite !== 'serial' && suite !== 'concurrent' && suite !== 'enginea' && suite !== 'all') {
    throw new Error(`未知 --suite：${suite}`);
  }
  return {
    suite: suite as Args['suite'],
    seconds: get('--seconds', 10),
    minutes: get('--minutes', 30),
    out: getStr('--out', '') || undefined,
  };
}

interface CheckResult {
  name: string;
  ok: boolean;
  /** 一行结论（含实测值） */
  detail: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** 临时工程：建工程 + 写入源文件（perf 自带 sketch，不依赖 examples） */
function makeProject(
  db: Db,
  name: string,
  files: Array<{ path: string; content: string }>,
): string {
  const meta = createProject(db, { name });
  for (const f of files) {
    db.prepare('INSERT INTO project_files (id, project_id, path, content) VALUES (?, ?, ?, ?)').run(
      `pf-${crypto.randomUUID()}`,
      meta.id,
      f.path,
      f.content,
    );
  }
  return meta.id;
}

/** 编译 → spawn QEMU → 连接 UART0 → durationMs 窗口流式回调（golden runner 引擎B 同款路径） */
async function runSession(
  db: Db,
  config: AppConfig,
  files: Array<{ path: string; content: string }>,
  name: string,
  durationMs: number,
  onLine: (line: string) => void,
): Promise<() => Promise<{ early: boolean; detail: string }>> {
  const projectId = makeProject(db, name, files);
  const builds = new BuildService({ db, config });
  const { buildId } = builds.submit(projectId, 'arduino');
  const rec = await builds.waitForFinish(buildId);
  if (rec.status !== 'success' || !rec.artifact) {
    const tail = (rec.log ?? '').split('\n').slice(-3).join(' | ');
    throw new Error(`编译未成功（status=${rec.status}）：${tail}`);
  }
  const qemu = new QemuManager({ config });
  const { sessionId } = await qemu.spawnSession({
    firmwarePath: join(builds.buildDir(buildId), rec.artifact),
    boardType: 'esp32-devkit-c-v4',
  });
  const serial = await qemu.connectSerial(sessionId);
  let buf = '';
  serial.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? '';
    for (const l of parts) if (l.trim()) onLine(l.trim());
  });
  return () =>
    new Promise<{ early: boolean; detail: string }>((res) => {
      // 窗口结束用短轮询而非长 setTimeout：分离进程下超长 timer 在 Windows 上
      // 观测到不触发（数据流正常而 timer 静默），500ms 轮询由事件循环稳定驱动
      const start = Date.now();
      const poll = setInterval(() => {
        if (Date.now() - start >= durationMs) {
          clearInterval(poll);
          res({ early: false, detail: '' });
        }
      }, 500);
      const offExit = qemu.onExit((sid, code, signal) => {
        if (sid !== sessionId) return;
        clearInterval(poll);
        res({ early: true, detail: `QEMU 退出（code=${code} signal=${signal}）` });
      });
      serial.once('error', (err: Error) => {
        clearInterval(poll);
        res({ early: true, detail: `串口错误：${err.message}` });
      });
      serial.once('close', () => {
        clearInterval(poll);
        res({ early: true, detail: '串口关闭' });
      });
      void offExit;
    }).then(async (r) => {
      await qemu.dispose(sessionId, 'perf done');
      return r;
    });
}

/** N:<seq> 流式连续性校验：跳过启动日志，首个样本锚定起点，此后 seq 必须 +1 严格连续 */
class SeqStream {
  private last: number | null = null;
  private count = 0;
  private firstGap: string | null = null;
  feed(line: string): void {
    const m = /^N:(\d+)$/.exec(line);
    if (!m) return;
    const seq = Number(m[1]);
    if (this.last !== null && seq !== this.last + 1 && !this.firstGap) {
      this.firstGap = `${this.last} → ${seq}`;
    }
    this.last = seq;
    this.count += 1;
  }
  verdict(windowS: number): { ok: boolean; detail: string } {
    if (this.count === 0) return { ok: false, detail: `未采集到任何样本（窗口 ${windowS}s）` };
    if (this.firstGap)
      return { ok: false, detail: `序号断裂：${this.firstGap}（${this.count} 行）` };
    return {
      ok: true,
      detail: `${this.count} 行 / ${windowS}s（${Math.round(this.count / windowS)} 行/s）零丢行`,
    };
  }
}

/** Si:N:<seq> 流：本会话标记连续性 + 外来标记检测（零互窜） */
class MarkerStream {
  private last: number | null = null;
  private count = 0;
  private firstGap: string | null = null;
  private foreign = 0;
  constructor(
    private readonly marker: string,
    private readonly others: string[],
  ) {}
  feed(line: string): void {
    if (this.others.some((o) => line.includes(`${o}:N:`))) {
      this.foreign += 1;
      return;
    }
    const m = new RegExp(`^${this.marker}:N:(\\d+)$`).exec(line);
    if (!m) return;
    const seq = Number(m[1]);
    if (this.last !== null && seq !== this.last + 1 && !this.firstGap) {
      this.firstGap = `${this.last} → ${seq}`;
    }
    this.last = seq;
    this.count += 1;
  }
  verdict(minutes: number): { ok: boolean; detail: string } {
    if (this.count === 0) return { ok: false, detail: `未采集到样本（窗口 ${minutes}min）` };
    if (this.foreign > 0)
      return { ok: false, detail: `串口互窜：检出 ${this.foreign} 条外来会话行` };
    if (this.firstGap)
      return { ok: false, detail: `序号断裂：${this.firstGap}（${this.count} 行）` };
    return { ok: true, detail: `${minutes}min ${this.count} 行，零互窜零丢行` };
  }
  get samples(): number {
    return this.count;
  }
}

// ---------------------------------------------------------------------------
// serial：115200 满速打印无丢行
// ---------------------------------------------------------------------------
const SERIAL_INO = `uint32_t n = 0;
void setup() { Serial.begin(115200); }
void loop() { Serial.printf("N:%lu\\n", (unsigned long)n++); }
`;

async function checkSerial(db: Db, config: AppConfig, seconds: number): Promise<CheckResult> {
  const stream = new SeqStream();
  try {
    const finish = await runSession(
      db,
      config,
      [{ path: 'main.ino', content: SERIAL_INO }],
      'perf-serial',
      seconds * 1000,
      (l) => stream.feed(l),
    );
    const { early, detail } = await finish();
    if (early) return { name: 'serial', ok: false, detail: `运行中断：${detail}` };
    const v = stream.verdict(seconds);
    return { name: 'serial', ok: v.ok, detail: `串口 115200 满速 ${seconds}s：${v.detail}` };
  } catch (err) {
    return { name: 'serial', ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// concurrent：4 并发会话（02-§3.5 / 06-§4 上限 4），零互窜 + 序号连续
// ---------------------------------------------------------------------------
const CONCURRENT_INO = (i: number) => `uint32_t n = 0;
void setup() { Serial.begin(115200); }
void loop() { Serial.printf("S${i}:N:%lu\\n", (unsigned long)n++); delay(200); }
`;

async function checkConcurrent(db: Db, config: AppConfig, minutes: number): Promise<CheckResult> {
  const N = 4;
  const markers = Array.from({ length: N }, (_, i) => `S${i + 1}`);
  const streams = markers.map(
    (m, i) =>
      new MarkerStream(
        m,
        markers.filter((_, j) => j !== i),
      ),
  );
  try {
    const finishes = await Promise.all(
      markers.map((_, i) =>
        runSession(
          db,
          config,
          [{ path: 'main.ino', content: CONCURRENT_INO(i + 1) }],
          `perf-conc-${i + 1}`,
          minutes * 60_000,
          // 只喂本会话自己的流：本串口出现他人标记（MarkerStream.foreign）即真互窜
          (l) => streams[i]?.feed(l),
        ).then((finish) => {
          dbg(`concurrent: session ${i + 1} ready`);
          return finish;
        }),
      ),
    );
    dbg('concurrent: all sessions ready, sampling window starts');
    const results = await Promise.all(finishes.map((f) => f()));
    dbg('concurrent: sampling window done');
    const early = results.find((r) => r.early);
    if (early) return { name: 'concurrent', ok: false, detail: `运行中断：${early.detail}` };
    for (let i = 0; i < N; i++) {
      const st = streams[i];
      if (!st) return { name: 'concurrent', ok: false, detail: `内部错误：流 ${i + 1} 缺失` };
      const v = st.verdict(minutes);
      if (!v.ok) return { name: 'concurrent', ok: false, detail: `会话 ${i + 1}：${v.detail}` };
    }
    const counts = streams.map((s, i) => `S${i + 1}=${s.samples}`).join(' ');
    return {
      name: 'concurrent',
      ok: true,
      detail: `4 并发 ${minutes}min：${counts}，零互窜零丢行`,
    };
  } catch (err) {
    return {
      name: 'concurrent',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// enginea：引擎A GPIO 事件同步投递延迟（有限突发 8 边沿，M5 golden 已验证区间）
//
// 吞吐受限（perf 复核实测，S2 遗留项，wasm 产物缺陷）：
// - time.sleep：Asyncify 挂起累计 ~16-20 次后进程静默死亡（0.05s×20 与 0.25s×16
//   均触发；blink 2-4 次正常）——持续 sleep 循环（1kHz blink）在引擎A 不可用；
// - 无 sleep 长循环：n≥10 次翻转单次 do_exec 即同步阻塞/硬死（实测 200000 次循环
//   5 分钟仅产生 22 边沿 ≈14s/边沿，n=10/50/200/1000 全部卡死）；
// - 同一实例第二次 async ccall 必崩；第三个 wasm 实例加载崩溃。
// 故本套件测"突发延迟"：8 边沿（4 次翻转）同步投递，间隔即事件延迟代理。
// 持续吞吐待 wasm 重建/上游修复后补测（02-§3.5 引擎A 行标注受限）。
const MPY_WASM_PATH = join(REPO_ROOT, 'apps', 'web', 'src', 'sim', 'mpy', 'micropython.wasm');
const ENGINEA_MAIN_PY = `from machine import Pin

led = Pin(4, Pin.OUT)
for i in range(4):
    led.value(1)
    led.value(0)
print("DONE")
`;

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
  _mp_sched_keyboard_interrupt?: () => void;
  lengthBytesUTF8: (str: string) => number;
  stringToUTF8: (str: string, outPtr: number, maxBytes: number) => void;
}

async function checkEngineA(seconds: number): Promise<CheckResult> {
  const gluePath = join(dirname(MPY_WASM_PATH), 'micropython.mjs');
  try {
    readFileSync(MPY_WASM_PATH);
    readFileSync(gluePath);
  } catch {
    return {
      name: 'enginea',
      ok: false,
      detail: '引擎A WASM 产物未入库（tools/mpy-build 先构建）',
    };
  }
  // 每个边沿打时间戳（gpioWrite 同步回调即事件到达时刻）
  const edges: number[] = [];
  (globalThis as unknown as Record<string, unknown>).__mpyMachine = {
    gpioWrite: () => {
      edges.push(Date.now());
    },
    gpioRead: (): number => 0,
    gpioConfigure: (): void => {},
    uartWrite: (): void => {},
    uartRead: (): Uint8Array | null => null,
    uartAvailable: (): number => 0,
  };
  let mod: MpyApiModule;
  try {
    dbg('enginea: import glue...');
    const glue = (await import(pathToFileURL(gluePath).href)) as {
      loadMicroPython: (opts?: Record<string, unknown>) => Promise<{ _module: MpyApiModule }>;
    };
    dbg('enginea: glue imported');
    const mp = await glue.loadMicroPython({
      url: MPY_WASM_PATH,
      stdout: (t: string) => dbg(`mp.out ${t}`),
      stderr: (t: string) => dbg(`mp.err ${t}`),
    });
    dbg('enginea: wasm loaded');
    mod = mp._module;
  } catch (err) {
    return {
      name: 'enginea',
      ok: false,
      detail: `wasm 加载失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    const len = mod.lengthBytesUTF8(ENGINEA_MAIN_PY);
    const buf = mod._malloc(len + 1);
    mod.stringToUTF8(ENGINEA_MAIN_PY, buf, len + 1);
    const value = mod._malloc(3 * 4);
    const t0 = Date.now();
    const done = mod.ccall(
      'mp_js_do_exec',
      'number',
      ['pointer', 'number', 'pointer'],
      [buf, len, value],
      { async: true },
    ) as unknown as Promise<number>;
    done.catch(() => {});
    dbg('enginea: do_exec started');
    // 突发脚本 <1s 完成；秒级窗口仅作进程挂死兜底（挂死即 fail）
    const elapsed = await Promise.race([
      done.then(() => Date.now() - t0),
      new Promise<number>((res) =>
        setTimeout(() => {
          mod._mp_sched_keyboard_interrupt?.();
          res(-1);
        }, seconds * 1000),
      ),
    ]);
    dbg(`enginea: do_exec settled elapsed=${elapsed} edges=${edges.length}`);
    if (elapsed < 0) {
      return {
        name: 'enginea',
        ok: false,
        detail: `突发脚本未在 ${seconds}s 内完成（wasm 挂死缺陷），边沿 ${edges.length}/8`,
      };
    }
  } catch (err) {
    return {
      name: 'enginea',
      ok: false,
      detail: `执行失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // 统计：边沿数与最大边沿间隔（同步投递延迟代理）
  dbg(`enginea: window done, edges=${edges.length}`);
  let maxGap = 0;
  for (let i = 1; i < edges.length; i++) {
    const prev = edges[i - 1];
    const cur = edges[i];
    if (prev === undefined || cur === undefined) continue;
    maxGap = Math.max(maxGap, cur - prev);
  }
  const ok = edges.length === 8 && maxGap <= 50;
  return {
    name: 'enginea',
    ok,
    detail:
      `GPIO 突发 8 边沿：实测 ${edges.length}，最大事件间隔 ${maxGap}ms（预算 ≤50ms；` +
      `持续吞吐受 wasm 产物稳定性限制未测，见套件注释 S2 遗留项；浏览器侧另有 16ms 批量聚合 N22）`,
  };
}

// ---------------------------------------------------------------------------

const DBG = 'D:/Workspaces/ESP32Simulator/m6-perf-debug.log';
function dbg(msg: string): void {
  try {
    writeSync(openSync(DBG, 'a'), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* 诊断专用 */
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  dbg(`start args=${JSON.stringify(args)}`);
  try {
    process.chdir(REPO_ROOT); // 相对路径（config/data）锚定仓库根
    dbg('chdir ok');
    const config = loadConfig(join(REPO_ROOT, 'config', 'app.json'));
    // perf 独立构建目录 + 关闭配额（conc30 实测踩坑）：本 CLI 用内存 DB，enforceQuota
    // 只能看见本运行的构建记录；共享 data/builds 的磁盘总量一旦超 quotaMb，扫描会按
    // "DB 最旧 finished"删除——即本运行刚完成的构建，QEMU spawn 随即 ENOENT flash.img。
    // 独立目录由 perf 自管（运行前清空），与 server 产物互不污染。
    config.builds.dir = 'data/builds-perf';
    config.builds.quotaMb = 1024 * 1024;
    rmSync(join(REPO_ROOT, 'data', 'builds-perf'), { recursive: true, force: true });
    // 会话空闲回收放宽到 schema 上限 24h（conc30 二次实测踩坑）：perf 直连 QEMU 原生
    // TCP 不经网关，QemuManager.resetIdleTimer 无 touch → 视角下会话全程"空闲"，
    // spawn+30min（flash.sessionTimeoutMs 默认，06-§4）整点 dispose → socket RST
    // （ECONNRESET 抢先于 exit 事件）→ 套件误报"运行中断"。perf 自管会话生命周期。
    config.flash.sessionTimeoutMs = 24 * 3_600_000;
    dbg('config ok');
    const db = openDatabase({ path: ':memory:', wal: false });
    runMigrations(db);
    dbg('db ok');

    const results: CheckResult[] = [];
    if (args.suite === 'enginea' || args.suite === 'all') {
      results.push(await checkEngineA(args.seconds));
      dbg(`enginea done ok=${results.at(-1)?.ok}`);
    }
    if (args.suite === 'serial' || args.suite === 'all') {
      results.push(await checkSerial(db, config, args.seconds));
      dbg(`serial done ok=${results.at(-1)?.ok}`);
    }
    if (args.suite === 'concurrent' || args.suite === 'all') {
      results.push(await checkConcurrent(db, config, args.minutes));
      dbg(`concurrent done ok=${results.at(-1)?.ok}`);
    }
    db.close();

    let failed = 0;
    const report: Array<{ fd: number; line: string }> = [
      { fd: 1, line: `性能复核（02-§3.5）suite=${args.suite} @ ${new Date().toISOString()}` },
    ];
    for (const r of results) {
      if (r.ok) report.push({ fd: 1, line: `[PASS] ${r.name}：${r.detail}` });
      else {
        failed += 1;
        report.push({ fd: 2, line: `[FAIL] ${r.name}：${r.detail}` });
      }
    }
    // 同步写 fd：stdout 重定向时异步缓冲会被 process.exit 截断（golden CLI 同款）
    for (const { fd, line } of report) writeSync(fd, `${line}\n`);
    dbg(`report fd written, out=${args.out ?? '<none>'}`);
    if (args.out) {
      const fd = openSync(resolve(process.cwd(), args.out), 'w');
      try {
        writeSync(fd, `${report.map((x) => x.line).join('\n')}\n`);
      } finally {
        closeSync(fd);
      }
      dbg('out file written');
    }
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    dbg(`ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(2);
  }
}

void main();
