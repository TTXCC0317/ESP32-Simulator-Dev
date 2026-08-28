import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, type Db } from './client';
import { runMigrations } from './migrator';

/**
 * L1：SQLite 连接（内存库 / 文件库 WAL / 目录自动创建）与迁移 runner
 * （01-§6.1：空库升级、幂等、事务回滚）。
 */

const tempDirs: string[] = [];
const dbs: Db[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'db-'));
  tempDirs.push(d);
  return d;
}

function track(db: Db): Db {
  dbs.push(db);
  return db;
}

describe('openDatabase', () => {
  it('内存库可用且 foreign_keys 开启', () => {
    const db = track(openDatabase({ path: ':memory:', wal: true }));
    expect(db.open).toBe(true);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('文件库自动创建多级目录并启用 WAL', () => {
    const dir = tempDir();
    const file = join(dir, 'nested', 'sub', 't.db');
    const db = track(openDatabase({ path: file, wal: true }));
    expect(existsSync(file)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('wal:false 时不改 journal mode（默认 delete）', () => {
    const dir = tempDir();
    const db = track(openDatabase({ path: join(dir, 't.db'), wal: false }));
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
  });
});

describe('runMigrations（01-§6.1）', () => {
  it('空库应用 0001_init.sql 并创建全部业务表', () => {
    const db = track(new Database(':memory:'));
    const r = runMigrations(db);
    expect(r.applied).toEqual(['0001_init.sql']);
    expect(r.total).toBe(1);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    for (const t of [
      '_migrations',
      'projects',
      'project_files',
      'parts_catalog',
      'board_pinmaps',
      'builds',
      'examples',
      'settings',
    ]) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
  });

  it('幂等：二次执行不重复应用', () => {
    const db = track(new Database(':memory:'));
    const first = runMigrations(db);
    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.total).toBe(first.total);
  });

  it('级联约束生效（project_files ON DELETE CASCADE）', () => {
    const db = track(new Database(':memory:'));
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      'INSERT INTO projects (id, name, diagram, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('p1', 'demo', '{}', now, now);
    db.prepare('INSERT INTO project_files (id, project_id, path, content) VALUES (?, ?, ?, ?)').run(
      'f1',
      'p1',
      'main.py',
      'print(1)',
    );
    db.prepare('DELETE FROM projects WHERE id = ?').run('p1');
    const n = db.prepare('SELECT COUNT(*) AS n FROM project_files').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('UNIQUE(project_id, path) 冲突被拒绝', () => {
    const db = track(new Database(':memory:'));
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      'INSERT INTO projects (id, name, diagram, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('p1', 'demo', '{}', now, now);
    const ins = db.prepare(
      'INSERT INTO project_files (id, project_id, path, content) VALUES (?, ?, ?, ?)',
    );
    ins.run('f1', 'p1', 'main.py', 'print(1)');
    expect(() => ins.run('f2', 'p1', 'main.py', 'print(2)')).toThrow(/UNIQUE/);
  });

  it('迁移失败时事务回滚，先前成功的迁移不受影响', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE t_ok(a);');
    // 0002 与 0001 冲突 → 整个 0002 事务回滚
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE t_ok(a);');
    const db = track(new Database(':memory:'));
    expect(() => runMigrations(db, `${dir}${sep}`)).toThrow();
    const rows = db.prepare('SELECT filename FROM _migrations ORDER BY filename').all() as Array<{
      filename: string;
    }>;
    expect(rows.map((r) => r.filename)).toEqual(['0001_ok.sql']);
  });
});
