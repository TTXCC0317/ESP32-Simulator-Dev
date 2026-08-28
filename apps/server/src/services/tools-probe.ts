import { execa } from 'execa';
import type { AppConfig } from '../config/schema';

/**
 * 工具链探测（02-§1.3 自检响应结构）
 *
 * 命令参数数组化执行（AGENTS.md 硬约束，禁 shell 拼接）；每条命令 5s 超时
 * （文档未规定探测超时，取保守值，M4 接编译链时复核）。runner 可注入以便测试 stub。
 */

export interface ToolProbe {
  ok: boolean;
  version?: string;
  reason?: string;
}

export interface ArduinoCliProbe extends ToolProbe {
  esp32Core?: string;
}

/** 02-§1.3 工具链自检响应 */
export interface ToolsStatus {
  node: string;
  git: ToolProbe;
  arduinoCli: ArduinoCliProbe;
  esptool: ToolProbe;
  qemu: ToolProbe;
}

export type CommandRunner = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

const DEFAULT_TIMEOUT_MS = 5_000;

export const execRunner: CommandRunner = async (file, args, timeoutMs) => {
  // reject:false：非零退出不是异常路径，stdout/stderr 交由调用方解析
  const r = await execa(file, args, { timeout: timeoutMs, reject: false, windowsHide: true });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

function firstLine(s: string): string {
  return s.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function extractVersion(s: string): string | undefined {
  const m = /\b[vV]?\d+\.\d+(?:\.\d+)?\b/.exec(s);
  return m?.[0];
}

function probeUnconfigured(toolKey: string): ToolProbe {
  return { ok: false, reason: `config.app.json 中 tools.${toolKey} 未配置` };
}

async function probeCommand(
  runner: CommandRunner,
  file: string,
  args: string[],
  label: string,
): Promise<ToolProbe> {
  if (!file.trim()) return probeUnconfigured(label);
  try {
    const { stdout, stderr } = await runner(file, args, DEFAULT_TIMEOUT_MS);
    const version = extractVersion(stdout) ?? extractVersion(stderr);
    if (!version) {
      return {
        ok: false,
        reason: `${label} 输出无法解析版本: ${firstLine(stdout || stderr) || '<empty>'}`,
      };
    }
    return { ok: true, version };
  } catch (err) {
    return {
      ok: false,
      reason: `${label} 探测失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function probeArduinoCli(
  runner: CommandRunner,
  cfg: AppConfig['tools'],
): Promise<ArduinoCliProbe> {
  if (!cfg.arduinoCli.trim()) return { ...probeUnconfigured('arduinoCli') };
  const base = await probeCommand(runner, cfg.arduinoCli, ['version'], 'arduinoCli');
  if (!base.ok) return base;

  // esp32 core 检测：core list 输出含 "esp32:esp32 x.y.z"
  try {
    const { stdout } = await runner(cfg.arduinoCli, ['core', 'list'], DEFAULT_TIMEOUT_MS);
    const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith(cfg.esp32Core));
    const version = line ? extractVersion(line) : undefined;
    return { ...base, esp32Core: version ?? `未安装 ${cfg.esp32Core}` };
  } catch {
    return { ...base, esp32Core: `未安装 ${cfg.esp32Core}` };
  }
}

/** 执行全量探测（/api/health/tools 实时调用；/api/health 用启动时缓存） */
export async function probeTools(
  cfg: AppConfig['tools'],
  runner: CommandRunner = execRunner,
): Promise<ToolsStatus> {
  const qemuFile = cfg.qemuXtensa.trim() || cfg.qemuRiscv32.trim();
  const [git, arduinoCli, esptool, qemu] = await Promise.all([
    probeCommand(runner, 'git', ['--version'], 'git'),
    probeArduinoCli(runner, cfg),
    probeCommand(runner, cfg.esptool, ['--version'], 'esptool'),
    qemuFile
      ? probeCommand(runner, qemuFile, ['--version'], 'qemu')
      : Promise.resolve(probeUnconfigured('qemuXtensa')),
  ]);
  return { node: process.version, git, arduinoCli, esptool, qemu };
}
