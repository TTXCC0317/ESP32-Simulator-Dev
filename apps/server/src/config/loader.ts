import { readFileSync } from 'node:fs';
import { appConfigSchema, type AppConfig } from './schema';

/**
 * config/app.json 加载与校验（01-§7 配置文件设计）
 */

export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

/**
 * 读取并校验配置；顶层段缺省时按 schema 默认值补齐。
 * @throws ConfigError 文件缺失 / JSON 非法 / 字段校验失败
 */
export function loadConfig(configPath = 'config/app.json'): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new ConfigError(
      `配置文件不存在: ${configPath}（请复制 config/app.example.json 为 config/app.json，并按本机工具链路径修改 tools 字段）`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ConfigError(`配置文件不是合法 JSON: ${configPath}`, { cause: err });
  }

  const parsed = appConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`配置校验失败（${configPath}）:\n${issues}`);
  }
  return parsed.data;
}
