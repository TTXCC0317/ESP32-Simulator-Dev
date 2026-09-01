import { execa, type ResultPromise } from 'execa';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/schema';
import type { Db } from '../db/client';
import { appRoot } from '../utils/app-root';

/**
 * BuildService（03-§7.1）：arduino-cli 编译队列
 *
 * - 并发上限 config.builds.maxConcurrent（默认 2），FIFO 排队；
 * - 流程：sketch 源码沙箱落盘 → arduino-cli compile → esptool merge_bin → flash.img；
 * - 超时 config.builds.timeoutMs（默认 5min）→ kill → status=failed（log 尾部标 timeout）；
 * - 日志流经 onEvent 回调（WS 网关 §7.4 聚合后推送 build.progress）；
 * - 磁盘配额（06-§4.1）：success 落盘后扫描，超限从最旧清理（跳过 pinned）。
 *
 * execa 命令参数一律数组化（06-§6 禁止 shell 拼接）；测试注入 runner 替身。
 */

export type BuildStatus = 'queued' | 'running' | 'success' | 'failed';
export type BuildPhase = 'queued' | 'compiling' | 'linking' | 'merging' | 'success' | 'failed';

export interface BuildRecord {
  id: string;
  projectId: string;
  toolchain: 'arduino' | 'esp-idf';
  status: BuildStatus;
  log: string | null;
  artifact: string | null;
  pinned: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface BuildEvent {
  kind: 'phase' | 'log';
  phase?: BuildPhase;
  line?: string;
  /** 0..1 估算进度（按输出行数） */
  progress?: number;
  /** failed 时错误摘要 */
  error?: string;
}

/** 可注入的编译执行器：file+args 数组化；onLine 回调 stdout/stderr 合流行 */
export type BuildRunner = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; onLine: (line: string) => void },
) => Promise<{ exitCode: number }>;

/** boardType → 编译目标（fqbn + esptool chip）；S3/C3 映射随 M5 真机验证
 *  FlashMode=dio：QEMU（Espressif fork）flash 模型不支持 QIO，
 *  默认 qio 启动即 assert（qio_mode: Failed to set QIE bit → init_flash fail） */
const BOARD_TOOLCHAIN: Record<string, { fqbn: string; chip: string }> = {
  'esp32-devkit-c-v4': { fqbn: 'esp32:esp32:esp32:FlashMode=dio', chip: 'esp32' },
  'esp32-s3-devkitc-1': { fqbn: 'esp32:esp32:esp32s3:FlashMode=dio', chip: 'esp32s3' },
  'esp32-c3-devkitm-1': { fqbn: 'esp32:esp32:esp32c3:FlashMode=dio', chip: 'esp32c3' },
};

/** 进度估算分母：arduino-cli 全量编译 ≈ 200 行输出 */
const ESTIMATE_LINES = 200;

/**
 * M5 GPIO 桥（03-§7.2 HAL 方案）：glue 源文件随 sketch 一起编译
 * （tools/bridge-glue/esp32sim_bridge.c，无 core 污染）。
 *
 * 拦截机制为强符号覆盖：core 3.x 的 pinMode/digitalWrite 等是 __pinMode 等真实
 * 实现的 weak alias，glue 强定义公开符号即被链接器优先采用（含 core 内部引用），
 * 无需 -Wl,--wrap（wrap 只重定向 undefined reference，对 weak alias 定义静默失效，
 * M5 golden 实测踩坑）。
 */
const BRIDGE_GLUE_SRC = 'esp32sim_bridge.c';
const BRIDGE_GLUE_DIR = resolve(appRoot(), 'tools', 'bridge-glue');

interface BuildJob {
  buildId: string;
  projectId: string;
  boardType: string;
}

interface BuildRow {
  id: string;
  project_id: string;
  toolchain: string;
  status: string;
  log: string | null;
  artifact: string | null;
  pinned: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function rowToRecord(r: BuildRow): BuildRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    toolchain: r.toolchain as BuildRecord['toolchain'],
    status: r.status as BuildStatus,
    log: r.log,
    artifact: r.artifact,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export class BuildService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly run: BuildRunner;
  private readonly now: () => number;

  private queue: BuildJob[] = [];
  private active = 0;
  private listeners = new Set<(buildId: string, ev: BuildEvent) => void>();
  private waiters = new Map<string, (r: BuildRecord) => void>();
  private logBuffers = new Map<string, string[]>();

  constructor(deps: { db: Db; config: AppConfig; run?: BuildRunner; now?: () => number }) {
    this.db = deps.db;
    this.config = deps.config;
    this.run = deps.run ?? defaultRunner;
    this.now = deps.now ?? Date.now;
  }

  /** 订阅编译事件（WS 网关推送用）；返回退订函数 */
  onEvent(cb: (buildId: string, ev: BuildEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * 提交编译（同步入队）：读工程 board_type + project_files → builds 表落库 queued。
   * 工程不存在 / 无 .ino 抛 HttpError（路由层转 4xx）。
   */
  submit(projectId: string, toolchain: 'arduino' | 'esp-idf'): { buildId: string } {
    if (toolchain !== 'arduino') {
      throw new Error(`toolchain '${toolchain}' M4 未支持（仅 arduino）`);
    }
    const project = this.db
      .prepare('SELECT board_type FROM projects WHERE id = ?')
      .get(projectId) as { board_type: string } | undefined;
    if (!project) throw new Error(`工程不存在：${projectId}`);

    const files = this.db
      .prepare('SELECT path, content FROM project_files WHERE project_id = ?')
      .all(projectId) as Array<{ path: string; content: string }>;
    if (!files.some((f) => f.path.endsWith('.ino'))) {
      throw new Error('工程缺少 .ino sketch 文件，无法提交 arduino 编译');
    }

    const buildId = `bld-${randomUUID().slice(0, 12)}`;
    this.db
      .prepare(
        'INSERT INTO builds (id, project_id, toolchain, status, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(buildId, projectId, toolchain, 'queued', this.now());
    this.logBuffers.set(buildId, []);

    this.queue.push({ buildId, projectId, boardType: project.board_type });
    this.emit(buildId, { kind: 'phase', phase: 'queued', progress: 0 });
    this.drain();
    return { buildId };
  }

  status(buildId: string): BuildRecord | null {
    const row = this.db.prepare('SELECT * FROM builds WHERE id = ?').get(buildId) as
      BuildRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** 编译工作目录（QemuManager 取 flash.img 用） */
  buildDir(buildId: string): string {
    return resolve(process.cwd(), this.config.builds.dir, buildId);
  }

  /** 运行中读内存缓冲，结束后读 DB log 字段（行数组） */
  logs(buildId: string): string[] {
    const buf = this.logBuffers.get(buildId);
    if (buf) return [...buf];
    const rec = this.status(buildId);
    return rec?.log ? rec.log.split('\n') : [];
  }

  /** building-wait 用：已结束直接 resolve，否则挂到 finish 事件 */
  waitForFinish(buildId: string): Promise<BuildRecord> {
    const rec = this.status(buildId);
    if (rec && rec.status !== 'queued' && rec.status !== 'running') return Promise.resolve(rec);
    return new Promise((res) => {
      this.waiters.set(buildId, res);
    });
  }

  // ---- 内部：队列调度 ----

  private drain(): void {
    while (this.active < this.config.builds.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      this.active += 1;
      void this.runJob(job);
    }
  }

  private async runJob(job: BuildJob): Promise<void> {
    const { buildId } = job;
    const dir = this.buildDir(buildId);
    const tc = BOARD_TOOLCHAIN[job.boardType];
    if (!tc) {
      this.finish(buildId, 'failed', `未知的板卡类型：${job.boardType}`);
      return;
    }

    // running：started_at + 落盘 sketch 沙箱
    this.db
      .prepare('UPDATE builds SET status = ?, started_at = ? WHERE id = ?')
      .run('running', this.now(), buildId);
    this.emit(buildId, { kind: 'phase', phase: 'compiling', progress: 0.01 });

    try {
      mkdirSync(dir, { recursive: true });
      const srcDir = this.writeSources(buildId, dir);
      const outDir = join(dir, 'build');
      mkdirSync(outDir, { recursive: true });

      // config.tools.* 允许相对路径（锚定仓库根 appRoot，.tools/ 不随 cwd 变化）；
      // spawn 的 cwd 是构建目录，相对路径必须在 spawn 前 resolve 为绝对路径
      // （否则 child 找不到可执行文件；pnpm --filter 启动时 cwd=apps/server）
      const arduinoCli = resolve(appRoot(), this.config.tools.arduinoCli);
      const esptool = resolve(appRoot(), this.config.tools.esptool);

      // 1) arduino-cli compile（超时由 runner 的 timeoutMs 强杀）
      //    GPIO 桥拦截走 glue 强符号覆盖（03-§7.2 M5），编译命令无需注入；
      //    M7 沙箱三保险：defaultRunner 会基于 ['compile',...] 自动前置
      //    --config-file + 追加 --build-path（= outDir），并提前 mkdir。
      let lines = 0;
      const compile = await this.run(
        arduinoCli,
        ['compile', '--fqbn', tc.fqbn, '--output-dir', outDir, '-v', srcDir],
        {
          cwd: dir,
          timeoutMs: this.config.builds.timeoutMs,
          onLine: (line) => {
            lines += 1;
            this.appendLog(buildId, line);
            const progress = Math.min(0.9, lines / ESTIMATE_LINES);
            this.emit(buildId, { kind: 'log', line, progress });
          },
        },
      );
      if (compile.exitCode !== 0) {
        // 末尾 40 行纳入错误消息（QEMU/Golden 失败报告常缺少具体行）
        const tail = this.logBuffers.get(buildId) ?? [];
        const tailMsg = tail.length > 0 ? `\n尾 40 行日志：\n${tail.slice(-40).join('\n')}` : '';
        throw new Error(`arduino-cli 编译失败（exit=${compile.exitCode}），详见构建日志${tailMsg}`);
      }

      // 2) esptool merge_bin（N18 布局：bootloader 0x1000 / partitions 0x8000 / app 0x10000）
      this.emit(buildId, { kind: 'phase', phase: 'merging', progress: 0.92 });
      const sketch = basename(srcDir);
      const imgPath = join(dir, 'flash.img');
      const merge = await this.run(
        esptool,
        [
          '--chip',
          tc.chip,
          'merge_bin',
          '-o',
          imgPath,
          '--flash_mode',
          'dio',
          '--flash_size',
          '4MB',
          // Espressif QEMU 要求镜像文件大小恰为 2/4/8/16MB（"only 2, 4, 8, 16 MB
          // flash images are supported"），merge_bin 默认不 pad → FF 补齐到 4MB
          '--fill-flash-size',
          '4MB',
          '0x1000',
          join(outDir, `${sketch}.ino.bootloader.bin`),
          '0x8000',
          join(outDir, `${sketch}.ino.partitions.bin`),
          '0x10000',
          join(outDir, `${sketch}.ino.bin`),
        ],
        { cwd: dir, timeoutMs: 30_000, onLine: (l) => this.appendLog(buildId, l) },
      );
      if (merge.exitCode !== 0) {
        throw new Error(`esptool merge_bin 失败（exit=${merge.exitCode}），详见构建日志`);
      }

      this.finish(buildId, 'success');
      this.enforceQuota();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finish(buildId, 'failed', msg);
    }
  }

  /** sketch 沙箱落盘：data/builds/<id>/src/<sketchName>/（目录名 = .ino basename，arduino-cli 要求） */
  private writeSources(buildId: string, dir: string): string {
    const files = this.db
      .prepare(
        'SELECT path, content FROM project_files WHERE project_id = (SELECT project_id FROM builds WHERE id = ?)',
      )
      .all(buildId) as Array<{ path: string; content: string }>;
    const ino = files.find((f) => f.path.endsWith('.ino'));
    if (!ino) throw new Error('缺少 .ino 文件');
    const sketchName = basename(ino.path, '.ino');
    const srcDir = join(dir, 'src', sketchName);
    mkdirSync(srcDir, { recursive: true });
    for (const f of files) {
      writeFileSync(join(srcDir, basename(f.path)), f.content, 'utf8');
    }
    // M5 GPIO 桥 glue 随 sketch 编译（缺失时编译命令仍下发，链接错误由日志暴露）
    try {
      copyFileSync(join(BRIDGE_GLUE_DIR, BRIDGE_GLUE_SRC), join(srcDir, BRIDGE_GLUE_SRC));
    } catch {
      this.appendLog(buildId, `[warn] GPIO 桥 glue 源缺失（${BRIDGE_GLUE_DIR}），跳过注入`);
    }
    return srcDir;
  }

  private appendLog(buildId: string, line: string): void {
    this.logBuffers.get(buildId)?.push(line);
  }

  private finish(buildId: string, status: 'success' | 'failed', error?: string): void {
    const finishedAt = this.now();
    const lines = this.logBuffers.get(buildId) ?? [];
    if (error) lines.push(`[error] ${error}`);
    const log = lines.join('\n');
    const artifact = status === 'success' ? 'flash.img' : null;
    this.db
      .prepare('UPDATE builds SET status = ?, log = ?, artifact = ?, finished_at = ? WHERE id = ?')
      .run(status, log, artifact, finishedAt, buildId);
    this.logBuffers.delete(buildId);
    this.emit(buildId, { kind: 'phase', phase: status, progress: 1, error });
    this.waiters.get(buildId)?.(this.status(buildId) as BuildRecord);
    this.waiters.delete(buildId);
    this.active -= 1;
    this.drain();
  }

  private emit(buildId: string, ev: BuildEvent): void {
    for (const cb of this.listeners) cb(buildId, ev);
  }

  /** 磁盘配额（06-§4.1）：超限从最旧 finished 构建清理到 0.9×quota（跳过 pinned）
   *
   * 仅统计 DB 里有的 buildId 目录大小——孤儿目录（DB 无对应行）不参与配额，
   * 否则 Golden CLI 用内存库时，历史残留的 bld-* 目录会让 total 虚高，
   * 而 DB 里只有刚 submit 的一行 → enforceQuota 误删刚编译的产物。
   * 孤儿目录由 cleanupOrphanedBuildDirs() 显式清理。 */
  private enforceQuota(): void {
    const root = resolve(process.cwd(), this.config.builds.dir);
    const rows = this.db
      .prepare(
        "SELECT id, pinned FROM builds WHERE status IN ('success','failed') ORDER BY finished_at ASC",
      )
      .all() as Array<{ id: string; pinned: number }>;
    let total = 0;
    for (const r of rows) total += dirSize(join(root, r.id));
    if (total <= this.config.builds.quotaMb * 1024 * 1024) return;

    const target = this.config.builds.quotaMb * 1024 * 1024 * 0.9;
    for (const r of rows) {
      if (total <= target) break;
      if (r.pinned === 1) continue;
      const d = join(root, r.id);
      const size = dirSize(d);
      rmSync(d, { recursive: true, force: true });
      // 产物被清理但记录保留（artifactMissing 语义：artifact 置空，log 保留）
      this.db.prepare('UPDATE builds SET artifact = NULL WHERE id = ?').run(r.id);
      total -= size;
    }
  }

  /** 测试/关闭钩子：终止队列中任务并清空（进程退出前调用） */
  dispose(): void {
    this.queue = [];
    this.listeners.clear();
  }
}

function dirSize(dir: string): number {
  let size = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    size += st.isDirectory() ? dirSize(p) : st.size;
  }
  return size;
}

/** 清理孤儿构建目录（data/builds/ 下不在 DB 的 bld-* 目录，对齐 QemuManager.cleanupOrphanedDirs）
 *
 * Golden CLI 用内存库启动时，所有文件系统残留的 bld-* 都是孤儿——若不清理，
 * enforceQuota 修复后虽不会误删 DB 里的新产物，但孤儿目录会持续占空间。
 * dev server 场景 DB 持久，孤儿目录较少（仅异常退出残留），可按需调用。
 * 返回清理的目录数。 */
export function cleanupOrphanedBuildDirs(config: AppConfig, db: Db): number {
  const root = resolve(process.cwd(), config.builds.dir);
  if (!existsSync(root)) return 0;
  const dbIds = new Set(
    (db.prepare('SELECT id FROM builds').all() as Array<{ id: string }>).map((r) => r.id),
  );
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!name.startsWith('bld-')) continue;
    if (dbIds.has(name)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // 单个目录失败不影响其余（下次重试）
    }
  }
  return removed;
}

/** 工具链目录（仓库内 data/，06-§6 允许写入，含 arduino-cli user/data/staging） */
const TOOLCHAIN_DATA_DIR = resolve(appRoot(), 'data', 'arduino');
const ARDUINO_USER_DIR = join(TOOLCHAIN_DATA_DIR, 'user');
const ARDUINO_DATA_DIR = join(TOOLCHAIN_DATA_DIR, 'data');
const ARDUINO_DOWNLOADS_DIR = join(TOOLCHAIN_DATA_DIR, 'staging');
const ARDUINO_LIBS_DIR = join(ARDUINO_USER_DIR, 'libraries');
const ARDUINO_CONFIG_FILE = join(ARDUINO_USER_DIR, 'cli.yaml');
const ARDUINO_BUILD_CACHE_DIR = resolve(appRoot(), 'data', 'build-cache');

/**
 * 写出 arduino-cli 配置文件（一次）。ARDUINO_* 环境变量在部分本地版本（0.x/1.x）
 * 静默不生效，导致 sketch 仍走 %LOCALAPPDATA% 缓存（沙箱 Access denied）；
 * --config-file + YAML 显式落盘 + compile --build-cache-path/--build-path 三保险
 * 让所有写操作（packages/staging/cache/build/sketches）全部在 data/ 目录内。
 */
function ensureArduinoConfig(): string {
  mkdirSync(ARDUINO_USER_DIR, { recursive: true });
  mkdirSync(join(ARDUINO_USER_DIR, 'sketches'), { recursive: true });
  mkdirSync(ARDUINO_DATA_DIR, { recursive: true });
  mkdirSync(ARDUINO_DOWNLOADS_DIR, { recursive: true });
  mkdirSync(ARDUINO_LIBS_DIR, { recursive: true });
  mkdirSync(ARDUINO_BUILD_CACHE_DIR, { recursive: true });
  const yaml =
    'directories:\n' +
    `  user: "${ARDUINO_USER_DIR.split('\\').join('\\\\')}"\n` +
    `  data: "${ARDUINO_DATA_DIR.split('\\').join('\\\\')}"\n` +
    `  downloads: "${ARDUINO_DOWNLOADS_DIR.split('\\').join('\\\\')}"\n` +
    `  builtin_libraries: "${ARDUINO_LIBS_DIR.split('\\').join('\\\\')}"\n`;
  const existing = (() => {
    try {
      return readFileSync(ARDUINO_CONFIG_FILE, 'utf8');
    } catch {
      return null;
    }
  })();
  if (existing !== yaml) writeFileSync(ARDUINO_CONFIG_FILE, yaml, 'utf8');
  return ARDUINO_CONFIG_FILE;
}

/** arduino-cli compile 的前置参数：--config-file YAML + --build-path 锚定到
 * data/builds/<id>/build（outDir）。调用方保持 compile 子命令参数不变，我们把目录控制
 * flags 直接拼在命令前面，兼容测试 runner（注入时 file = 'arduino-fake' 不走实逻辑）。
 *
 * ⚠️ 不使用已弃用 flag --build-cache-path：arduino-cli 1.x 将 build cache 与 build-path
 * 合二为一；用户目录/cache 由 YAML 的 directories.user 接管。
 */
function prependArduinoCompileFlags(args: readonly string[], buildDir: string): string[] {
  if (args[0] !== 'compile') return [...args];
  const out = args.indexOf('--output-dir');
  // args[out+1] 可能 undefined（out=-1 或 out=args.length-1），fallback 到
  // buildDir/build；显式 as string 收紧类型，消除 mkdirSync / 返回数组 TS2322。
  const artifactDir =
    (out !== -1 && out + 1 < args.length ? (args[out + 1] as string) : undefined) ??
    join(buildDir, 'build');
  // ⚠️ 目录必须真实存在：arduino-cli 即使传 --build-path，仍会在
  // directories.user/sketches/<hash> 起临时 build 目录（不可关闭），
  // 因此 ensureArduinoConfig() 需一并创建 sketches 根。
  ensureArduinoConfig();
  mkdirSync(join(ARDUINO_USER_DIR, 'sketches'), { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  // M7 引擎B glue analogWrite/analogWriteFrequency 提供同名强定义覆盖 core
  // 实现（esp32 core 3.3.10 esp32-hal-ledc.c 中该两符号非 weak alias，与 glue
  // 冲突会报 multiple definition）。用 --allow-multiple-definition 允许链接器取
  // 首个定义（sketch 的 esp32sim_bridge.c.o 排在 core.a 前，因此生效 glue）。
  return [
    '--config-file',
    ARDUINO_CONFIG_FILE,
    'compile',
    ...args.slice(1),
    '--build-path',
    artifactDir,
    '--build-property',
    'compiler.c.elf.extra_flags=-Wl,--allow-multiple-definition',
  ];
}

/** 生产 runner：execa + stdout/stderr 合流按行回调（超时进程被 execa 强杀并 reject）
 *
 * ⚠️ ARDUINO 目录隔离（M7 补丁）：Trae 沙箱与部分受控环境拒绝写入
 * `%LOCALAPPDATA%\Arduino15` / `%LOCALAPPDATA%\arduino\sketches` 下的 cache /
 * sketch 哈希目录。三保险：(1) --config-file YAML 落盘 directories.* 到 data/arduino/；
 * (2) compile 追加 --build-cache-path + --build-path（data/build-cache 与 data/builds/<id>/build）；
 * (3) 进程 env 也同步 ARDUINO_DIRECTORIES_*（作为未来新版 fallback）。以上仍受
 * 06-§6 data/ 目录统一路径穿越限制。
 */
function arduinoEnv(): NodeJS.ProcessEnv {
  ensureArduinoConfig();
  return {
    ...process.env,
    ARDUINO_DIRECTORIES_USER: ARDUINO_USER_DIR,
    ARDUINO_DIRECTORIES_DATA: ARDUINO_DATA_DIR,
    ARDUINO_DIRECTORIES_DOWNLOADS: ARDUINO_DOWNLOADS_DIR,
    ARDUINO_DIRECTORIES_BUILTIN_LIBRARIES: ARDUINO_LIBS_DIR,
  };
}

const defaultRunner: BuildRunner = async (file, args, opts) => {
  let lineBuf = '';
  const onChunk = (chunk: Buffer | string): void => {
    lineBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const parts = lineBuf.split(/\r?\n/);
    lineBuf = parts.pop() ?? '';
    for (const line of parts) if (line) opts.onLine(line);
  };

  const isArduino = file.includes('arduino-cli');
  const resolvedArgs = isArduino ? prependArduinoCompileFlags(args, opts.cwd) : [...args];
  const child: ResultPromise = execa(file, resolvedArgs, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    killSignal: 'SIGKILL',
    buffer: false,
    reject: false,
    env: isArduino ? arduinoEnv() : process.env,
  });
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  const result = await child;
  if (lineBuf) opts.onLine(lineBuf);
  if (result.timedOut)
    throw new Error(`编译超时（${Math.round(opts.timeoutMs / 1000)}s），进程已终止`);
  return { exitCode: result.exitCode ?? -1 };
};

/** 供 QemuManager 复用：从 build 目录把 flash.img 复制到会话目录 */
export function copyFlashImage(buildDir: string, sessionDir: string): void {
  mkdirSync(sessionDir, { recursive: true });
  cpSync(join(buildDir, 'flash.img'), join(sessionDir, 'flash.img'));
}
