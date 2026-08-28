import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './client';

/**
 * 轻量迁移 runner（《01-总体设计方案》§6.1 N15）
 *
 * - `_migrations` 表记录已应用文件名；按字典序应用未执行的 .sql；
 * - 每个 migration 包在 transaction 里（失败回滚）；
 * - 不可逆：不写 down 脚本，回滚靠 git revert + 删库重建；
 * - 已应用的文件不可修改（改用新编号追加）。
 */

export interface MigrationResult {
  /** 本次应用的迁移文件名（新应用的在前） */
  applied: string[];
  /** 库中已记录的迁移总数（含历史） */
  total: number;
}

/**
 * @param migrationsDir .sql 迁移文件目录；默认取本模块旁的 migrations/
 *   （dev 由 tsx 直接执行 src 下文件；生产构建需保证该目录随 dist 一起部署，P2 §8 打包时处理）
 */
export function runMigrations(db: Db, migrationsDir?: string): MigrationResult {
  const dir = migrationsDir ?? fileURLToPath(new URL('./migrations/', import.meta.url));

  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id          INTEGER PRIMARY KEY,
    filename    TEXT NOT NULL UNIQUE,
    applied_at  INTEGER NOT NULL
  )`);

  const appliedRows = db.prepare('SELECT filename FROM _migrations').all() as Array<{
    filename: string;
  }>;
  const applied = new Set(appliedRows.map((r) => r.filename));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const run = db.transaction((filename: string, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(
      filename,
      Date.now(),
    );
  });

  const appliedNow: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(`${dir}${f}`, 'utf8');
    run(f, sql);
    appliedNow.push(f);
  }

  const total =
    (db.prepare('SELECT COUNT(*) AS n FROM _migrations').all() as Array<{ n: number }>)[0]?.n ?? 0;
  return { applied: appliedNow.reverse(), total };
}
