import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema';

/**
 * SQLite 连接（《01-总体设计方案》§6 /《03-核心模块详细设计》§6.4 约束）
 *
 * better-sqlite3 同步 API，不写异步封装；WAL 由配置控制（M3 验收核对点）。
 */
export type Db = Database.Database;

export function openDatabase(cfg: AppConfig['db'], cwd = process.cwd()): Db {
  if (cfg.path === ':memory:') {
    // 测试专用：内存库（不经 resolve，保留 better-sqlite3 特殊路径语义）
    const mem = new Database(':memory:');
    mem.pragma('foreign_keys = ON');
    return mem;
  }
  const file = resolve(cwd, cfg.path);
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  if (cfg.wal) {
    db.pragma('journal_mode = WAL');
  }
  // 单机定位：外键约束始终开启（project_files/builds 级联删除依赖）
  db.pragma('foreign_keys = ON');
  return db;
}
