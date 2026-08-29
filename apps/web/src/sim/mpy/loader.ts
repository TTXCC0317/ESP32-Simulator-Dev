import type { FirmwareSourceFiles } from '@esp32-sim/shared';

/**
 * MicroPython-WASM 加载器（03-§3.4）。
 *
 * 产物为官方 v1.26 webassembly port 命名：micropython.wasm + micropython.mjs
 * （Emscripten glue，由 tools/mpy-build 定制构建生成入库）。
 *
 * v1.26 要点（产物实测，micropython.mjs api.js 段）：
 * - 初始化 mp_js_init(pystack, heapsize) 双参，由 glue 的 loadMicroPython() 内部完成；
 * - 执行入口 mp_js_do_exec(buf, len, out)（旧 mp_js_do_str 已移除）；
 * - ASYNCIFY 启用：time.sleep 挂起而非阻塞事件循环，执行须用 ccall {async:true}；
 * - stdout/stderr 经行缓冲回调（linebuffer 默认 true，按 \n 切行）。
 *
 * glue/wasm 以运行期 URL 加载（不进 rollup 打包，避免 base64 内联与产物缺失时
 * 构建失败；M8 静态托管阶段随产物文件一起部署）。
 */

// 产物 URL（dev：Vite 按 /src/sim/mpy/ 服务；prod：需与 wasm 一起部署）
const GLUE_URL = new URL('./micropython.mjs', import.meta.url).href;
const WASM_URL = new URL('./micropython.wasm', import.meta.url).href;

/** Emscripten FS 命名空间（FORCE_FILESYSTEM 启用后存在） */
interface EmscriptenFS {
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string): Uint8Array;
  mkdirTree(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

/** 定制构建的 MicroPython 模块面（Emscripten Module，能力按需探测） */
export interface MpyModule {
  // 执行入口：mp_js_do_exec(buf, len, outPtr)，Asyncify 下必须 async:true
  ccall: (
    ident: string,
    returnType: string | null,
    argTypes: string[],
    args: unknown[],
    opts?: { async?: boolean },
  ) => unknown;
  FS?: EmscriptenFS;
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  lengthBytesUTF8: (str: string) => number;
  stringToUTF8: (str: string, outPtr: number, maxBytes: number) => void;
  // 停止中断（v1.26 改名自 mp_keyboard_interrupt，port Makefile 已导出）
  _mp_sched_keyboard_interrupt?: () => void;
  // GPIO 注入入口（M5：PinBus onChange → wasm irq 回调，machine.c 定义）
  _mp_js_gpio_inject?: (pin: number, level: number) => void;
}

/** glue loadMicroPython 返回的官方 API 面（仅取所需字段） */
interface MpyApi {
  _module: MpyModule;
  FS?: EmscriptenFS;
}

export interface LoadedMpy {
  mod: MpyModule;
  /** stdout 行回调（print 按行聚合，linebuffer） */
  onStdout: (cb: (line: string) => void) => void;
  /** stderr 行回调 */
  onStderr: (cb: (line: string) => void) => void;
  /** 能力探针结果（engine 决定执行路径） */
  caps: {
    doExec: boolean;
    fs: boolean;
    interrupt: boolean;
    inject: boolean;
  };
}

/**
 * 加载并初始化 MicroPython wasm 模块（复用官方 loadMicroPython：
 * pystack 2KB / GC heap 1MB 默认值，mp_js_init + proxy_c_init 由其内部完成）。
 */
export async function loadMicroPython(): Promise<LoadedMpy> {
  let stdoutLines: ((line: string) => void) | null = null;
  let stderrLines: ((line: string) => void) | null = null;

  let glue: { loadMicroPython: (opts?: Record<string, unknown>) => Promise<MpyApi> };
  try {
    // 运行期按 URL 加载 glue（@vite-ignore：不进打包，产物文件由 tools/mpy-build 提供）
    glue = (await import(/* @vite-ignore */ GLUE_URL)) as {
      loadMicroPython: (opts?: Record<string, unknown>) => Promise<MpyApi>;
    };
  } catch (err) {
    throw new Error(
      'MicroPython WASM 产物未就位：请先运行 tools/mpy-build 定制构建（docker build + docker run），产物入库 apps/web/src/sim/mpy/。' +
        `原始错误：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const mp = await glue.loadMicroPython({
    // url 完整替换 glue 的 locateFile → wasm 产物绝对 URL（部署位置与 glue 解耦）
    url: WASM_URL,
    stdout: (line: string) => stdoutLines?.(line),
    stderr: (line: string) => stderrLines?.(line),
  });

  const mod = mp._module;
  const caps = {
    doExec: typeof mod.ccall === 'function',
    fs: mp.FS !== undefined,
    interrupt: typeof mod._mp_sched_keyboard_interrupt === 'function',
    inject: typeof mod._mp_js_gpio_inject === 'function',
  };

  return {
    mod,
    onStdout: (cb) => (stdoutLines = cb),
    onStderr: (cb) => (stderrLines = cb),
    caps,
  };
}

/**
 * VFS 写入（03-§3.3：load() 将 files 写入内存文件系统，支持 import 相对模块）。
 * FORCE_FILESYSTEM 未生效（FS 缺失）时返回 false，engine 降级为单文件执行。
 */
export function writeVfs(mod: MpyModule, files: FirmwareSourceFiles['files']): boolean {
  if (!mod.FS) return false;
  for (const f of files) {
    const path = f.path.startsWith('/') ? f.path : `/${f.path}`;
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    if (dir !== '/' && !mod.FS.analyzePath(dir).exists) mod.FS.mkdirTree(dir);
    mod.FS.writeFile(path, f.content);
  }
  return true;
}
