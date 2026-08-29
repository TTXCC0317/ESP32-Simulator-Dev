import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, type Db } from '../db/client';
import { runMigrations } from '../db/migrator';
import { seedExamples } from '../db/seed';
import {
  ProjectNotFoundError,
  copyProject,
  createProject,
  deleteProject,
  exportProject,
  getProjectDetail,
  importProjectBundle,
  updateProject,
} from './projects.service';

/**
 * L1：projects.service CRUD / 复制 / 导出→清库→导入还原 / 文件唯一约束
 * （02-§4 M3 测试项、01-§6 examples 表）。
 */

const dbs: Db[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
});

function makeDb() {
  const db = openDatabase({ path: ':memory:', wal: false });
  runMigrations(db);
  seedExamples(db);
  dbs.push(db);
  return db;
}

describe('createProject', () => {
  it('空白工程：默认板卡/引擎 + 初始 diagram 含板卡元件', () => {
    const db = makeDb();
    const meta = createProject(db, { name: 'demo' });
    expect(meta.id).toBeTruthy();
    expect(meta.name).toBe('demo');
    expect(meta.boardType).toBe('esp32-devkit-c-v4');
    expect(meta.engine).toBe('micropython-wasm');
    expect(meta.thumbnail).toBeNull();

    const detail = getProjectDetail(db, meta.id);
    expect(detail?.diagram.boardType).toBe('board-esp32-devkit-c-v4');
    expect(detail?.diagram.parts[0]?.type).toBe('board-esp32-devkit-c-v4');
    expect(detail?.files).toEqual([]);
  });

  it('从示例创建：manifest 的 diagram 与 files 落库', () => {
    const db = makeDb();
    const meta = createProject(db, { name: 'blink demo', exampleId: 'blink' });
    const detail = getProjectDetail(db, meta.id);
    expect(detail?.diagram.parts.map((p) => p.type)).toContain('wokwi-led');
    expect(detail?.files.map((f) => f.path)).toEqual(['main.ino', 'main.py']);
    expect(detail?.files[0]?.content).toContain('digitalWrite');
  });

  it('exampleId 不存在抛 ExampleNotFoundError', () => {
    const db = makeDb();
    expect(() => createProject(db, { name: 'x', exampleId: 'nope' })).toThrow(/Example nope/);
  });
});

describe('updateProject / deleteProject', () => {
  it('部分更新：仅改 name 不动 diagram；files 全量替换', () => {
    const db = makeDb();
    const meta = createProject(db, { name: 'demo' });
    updateProject(db, meta.id, { name: 'renamed' });
    const d1 = getProjectDetail(db, meta.id);
    expect(d1?.name).toBe('renamed');
    expect(d1?.diagram.parts).toHaveLength(1);

    updateProject(db, meta.id, {
      files: [
        { path: 'main.py', content: 'print(1)' },
        { path: 'lib/util.py', content: 'x = 1' },
      ],
    });
    const d2 = getProjectDetail(db, meta.id);
    expect(d2?.files.map((f) => f.path)).toEqual(['lib/util.py', 'main.py']);

    // 再替换为空集 → 清空
    updateProject(db, meta.id, { files: [] });
    expect(getProjectDetail(db, meta.id)?.files).toEqual([]);
  });

  it('更新的 updated_at 单调递增且列表按其倒序', async () => {
    const db = makeDb();
    const a = createProject(db, { name: 'a' });
    // updated_at 为 ms 粒度：同毫秒内并列会使 ORDER BY 不稳定，间隔 3ms 保证严格递增
    await new Promise((r) => setTimeout(r, 3));
    const b = createProject(db, { name: 'b' });
    await new Promise((r) => setTimeout(r, 3));
    updateProject(db, a.id, { description: 'touch' });
    const rows = db.prepare('SELECT id FROM projects ORDER BY updated_at DESC').all() as Array<{
      id: string;
    }>;
    expect(rows[0]?.id).toBe(a.id);
    expect(rows[1]?.id).toBe(b.id);
  });

  it('删除级联清理 project_files；不存在返回 false', () => {
    const db = makeDb();
    const meta = createProject(db, { name: 'demo' });
    updateProject(db, meta.id, { files: [{ path: 'main.py', content: 'x' }] });
    expect(deleteProject(db, meta.id)).toBe(true);
    expect(getProjectDetail(db, meta.id)).toBeNull();
    const n = db.prepare('SELECT COUNT(*) n FROM project_files').get() as { n: number };
    expect(n.n).toBe(0);
    expect(deleteProject(db, 'missing')).toBe(false);
  });

  it('更新不存在的工程抛 ProjectNotFoundError', () => {
    const db = makeDb();
    expect(() => updateProject(db, 'missing', { name: 'x' })).toThrow(ProjectNotFoundError);
  });
});

describe('copyProject（04-§8 复制）', () => {
  it('复制名称追加“副本”，diagram/files/thumbnail 原样拷贝', () => {
    const db = makeDb();
    const meta = createProject(db, { name: 'demo', exampleId: 'blink' });
    updateProject(db, meta.id, { thumbnail: 'data:image/png;base64,xxx' });
    const copy = copyProject(db, meta.id);
    // createProject 以 opts.name 命名（示例只提供 diagram/files/板卡），复制追加“副本”
    expect(copy?.name).toBe('demo 副本');
    expect(copy?.thumbnail).toBe('data:image/png;base64,xxx');

    const src = getProjectDetail(db, meta.id);
    const dst = getProjectDetail(db, (copy as { id: string }).id);
    expect(dst?.diagram).toEqual(src?.diagram);
    expect(dst?.files).toEqual(src?.files);
  });

  it('复制不存在的工程返回 null', () => {
    const db = makeDb();
    expect(copyProject(db, 'missing')).toBeNull();
  });
});

describe('export → 清库 → importProjectBundle 还原（02-§4 M3 验收）', () => {
  it('导出 JSON 包导入新库后完整还原', () => {
    const dbA = makeDb();
    const meta = createProject(dbA, { name: 'roundtrip', exampleId: 'blink' });
    updateProject(dbA, meta.id, { files: [{ path: 'extra.py', content: '# extra' }] });
    const bundle = exportProject(dbA, meta.id);
    expect(bundle?.formatVersion).toBe(1);
    expect(bundle?.project.name).toBe('roundtrip');

    // 模拟清库（新内存库，不再种子）
    const dbB = openDatabase({ path: ':memory:', wal: false });
    runMigrations(dbB);
    dbs.push(dbB);

    const restored = importProjectBundle(dbB, bundle as NonNullable<typeof bundle>);
    const detail = getProjectDetail(dbB, restored.id);
    expect(detail?.name).toBe('roundtrip');
    expect(detail?.diagram).toEqual(bundle?.diagram);
    // files 为全量替换语义：updateProject 后仅剩 extra.py，导出→导入按包内容还原
    expect(detail?.files.map((f) => f.path)).toEqual(['extra.py']);
  });

  it('导出不存在的工程返回 null', () => {
    const db = makeDb();
    expect(exportProject(db, 'missing')).toBeNull();
  });
});
