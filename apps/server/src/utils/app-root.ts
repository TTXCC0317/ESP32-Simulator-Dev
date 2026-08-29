import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * 仓库根目录探测：无论从仓库根（node dist/index.js）还是 apps/server（tsx watch / pnpm --filter）
 * 启动，都能定位到 config/ 与 data/ 所在的根目录。
 *
 * 判据：pnpm-workspace.yaml（monorepo 根固定存在，随包分发不会进入子目录）。
 */
let cached: string | null = null;

export function appRoot(start = process.cwd()): string {
  if (cached) return cached;
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      cached = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：未找到 monorepo 标记时按 cwd 处理（保持 01-§7 cwd 相对语义）
  cached = resolve(start);
  return cached;
}
