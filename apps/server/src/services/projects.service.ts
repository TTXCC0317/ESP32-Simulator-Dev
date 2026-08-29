import { randomUUID } from 'node:crypto';
import type {
  CircuitDoc,
  EngineId,
  ProjectBundle,
  ProjectDetail,
  ProjectFileEntry,
  ProjectMeta,
} from '@esp32-sim/shared';
import type { Db } from '../db/client';
import type { ExampleManifest } from '../db/seed';

/**
 * 工程 CRUD / 复制 / 导出 / 导入（01-§5.2 REST 的 DB 层）
 *
 * better-sqlite3 同步 API，不写异步封装（03-§6.4）。
 * 校验（规模/路径/电路）在路由层完成，本层只管持久化与行映射。
 */

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  board_type: string;
  engine: string;
  diagram: string;
  thumbnail: string | null;
  created_at: number;
  updated_at: number;
}

function now(): number {
  return Date.now();
}

function rowToMeta(r: ProjectRow): ProjectMeta {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    boardType: r.board_type,
    engine: r.engine as EngineId,
    thumbnail: r.thumbnail,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToDetail(r: ProjectRow): ProjectDetail {
  return {
    ...rowToMeta(r),
    diagram: JSON.parse(r.diagram) as CircuitDoc,
    files: [],
  };
}

/** 列表：按 updated_at 倒序（04-§8 卡片顺序） */
export function listProjects(db: Db): ProjectMeta[] {
  const rows = db
    .prepare(
      'SELECT id, name, description, board_type, engine, thumbnail, created_at, updated_at FROM projects ORDER BY updated_at DESC',
    )
    .all() as ProjectRow[];
  return rows.map(rowToMeta);
}

export function getProjectMeta(db: Db, id: string): ProjectMeta | null {
  const row = db
    .prepare(
      'SELECT id, name, description, board_type, engine, thumbnail, created_at, updated_at FROM projects WHERE id = ?',
    )
    .get(id) as ProjectRow | undefined;
  return row ? rowToMeta(row) : null;
}

export function getProjectDetail(db: Db, id: string): ProjectDetail | null {
  const row = db
    .prepare(
      'SELECT id, name, description, board_type, engine, diagram, thumbnail, created_at, updated_at FROM projects WHERE id = ?',
    )
    .get(id) as ProjectRow | undefined;
  if (!row) return null;
  const detail = rowToDetail(row);
  detail.files = db
    .prepare('SELECT path, content FROM project_files WHERE project_id = ? ORDER BY path')
    .all(id) as ProjectFileEntry[];
  return detail;
}

export function listFiles(db: Db, projectId: string): ProjectFileEntry[] {
  return db
    .prepare('SELECT path, content FROM project_files WHERE project_id = ? ORDER BY path')
    .all(projectId) as ProjectFileEntry[];
}

/** 全量替换工程文件（事务内 DELETE + INSERT，满足 UNIQUE(project_id, path)） */
export function replaceFiles(db: Db, projectId: string, files: ProjectFileEntry[]): void {
  const del = db.prepare('DELETE FROM project_files WHERE project_id = ?');
  const ins = db.prepare(
    'INSERT INTO project_files (id, project_id, path, content) VALUES (?, ?, ?, ?)',
  );
  db.transaction(() => {
    del.run(projectId);
    for (const f of files) {
      ins.run(randomUUID(), projectId, f.path, f.content);
    }
  })();
}

/** 空白工程的初始 diagram（板卡居左上，无连线，115200） */
export function blankDiagram(boardType: string): CircuitDoc {
  return {
    formatVersion: 1,
    boardType: `board-${boardType}`,
    parts: [{ id: 'esp', type: `board-${boardType}`, left: 60, top: 60, rotate: 0, attrs: {} }],
    connections: [],
    serialMonitor: { baudrate: 115200 },
  };
}

export interface CreateProjectOpts {
  name: string;
  description?: string;
  boardType?: string;
  engine?: EngineId;
  /** 内置示例 id：从 examples.manifest 实例化（01-§6.1） */
  exampleId?: string;
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project ${id} not found`);
    this.name = 'ProjectNotFoundError';
  }
}

export function createProject(db: Db, opts: CreateProjectOpts): ProjectMeta {
  const id = randomUUID();
  const ts = now();
  let boardType = opts.boardType ?? 'esp32-devkit-c-v4';
  let engine = opts.engine ?? 'micropython-wasm';
  let diagram: CircuitDoc = blankDiagram(boardType);
  let files: ProjectFileEntry[] = [];

  if (opts.exampleId) {
    const row = db
      .prepare('SELECT name, manifest_json FROM examples WHERE id = ?')
      .get(opts.exampleId) as { name: string; manifest_json: string } | undefined;
    if (!row) {
      throw new ExampleNotFoundError(opts.exampleId);
    }
    const manifest = JSON.parse(row.manifest_json) as ExampleManifest;
    boardType = manifest.boardType.replace(/^board-/, '');
    engine = manifest.engine as EngineId;
    diagram = JSON.parse(manifest.diagram) as CircuitDoc;
    files = manifest.files;
  }

  const insert = db.prepare(
    'INSERT INTO projects (id, name, description, board_type, engine, diagram, thumbnail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
  );
  db.transaction(() => {
    insert.run(
      id,
      opts.name,
      opts.description ?? '',
      boardType,
      engine,
      JSON.stringify(diagram),
      ts,
      ts,
    );
    if (files.length > 0) replaceFiles(db, id, files);
  })();

  return getProjectMeta(db, id) as ProjectMeta;
}

export class ExampleNotFoundError extends Error {
  constructor(id: string) {
    super(`Example ${id} not found`);
    this.name = 'ExampleNotFoundError';
  }
}

export interface UpdateProjectPatch {
  name?: string;
  description?: string;
  boardType?: string;
  engine?: EngineId;
  diagram?: CircuitDoc;
  files?: ProjectFileEntry[];
  thumbnail?: string | null;
}

/** 部分更新：给出的字段整体替换（files 全量替换）；工程不存在抛 ProjectNotFoundError */
export function updateProject(db: Db, id: string, patch: UpdateProjectPatch): ProjectMeta {
  const row = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
  if (!row) throw new ProjectNotFoundError(id);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    vals.push(patch.description);
  }
  if (patch.boardType !== undefined) {
    sets.push('board_type = ?');
    vals.push(patch.boardType);
  }
  if (patch.engine !== undefined) {
    sets.push('engine = ?');
    vals.push(patch.engine);
  }
  if (patch.diagram !== undefined) {
    sets.push('diagram = ?');
    vals.push(JSON.stringify(patch.diagram));
  }
  if (patch.thumbnail !== undefined) {
    sets.push('thumbnail = ?');
    vals.push(patch.thumbnail);
  }
  sets.push('updated_at = ?');
  vals.push(now());
  vals.push(id);

  db.transaction(() => {
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (patch.files !== undefined) replaceFiles(db, id, patch.files);
  })();

  return getProjectMeta(db, id) as ProjectMeta;
}

export function deleteProject(db: Db, id: string): boolean {
  const r = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return r.changes > 0;
}

/** 复制工程（04-§8 卡片操作"复制"）：名称追加" 副本"，内容与缩略图原样拷贝 */
export function copyProject(db: Db, id: string): ProjectMeta | null {
  const src = db
    .prepare(
      'SELECT id, name, description, board_type, engine, diagram, thumbnail FROM projects WHERE id = ?',
    )
    .get(id) as
    | Pick<
        ProjectRow,
        'id' | 'name' | 'description' | 'board_type' | 'engine' | 'diagram' | 'thumbnail'
      >
    | undefined;
  if (!src) return null;

  const newId = randomUUID();
  const ts = now();
  const insert = db.prepare(
    'INSERT INTO projects (id, name, description, board_type, engine, diagram, thumbnail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    insert.run(
      newId,
      `${src.name} 副本`,
      src.description ?? '',
      src.board_type,
      src.engine,
      src.diagram,
      src.thumbnail,
      ts,
      ts,
    );
    const files = listFiles(db, id);
    const ins = db.prepare(
      'INSERT INTO project_files (id, project_id, path, content) VALUES (?, ?, ?, ?)',
    );
    for (const f of files) {
      ins.run(randomUUID(), newId, f.path, f.content);
    }
  })();

  return getProjectMeta(db, newId);
}

/** 导出 JSON 包（M3 formatVersion:1）；工程不存在返回 null */
export function exportProject(db: Db, id: string): ProjectBundle | null {
  const detail = getProjectDetail(db, id);
  if (!detail) return null;
  return {
    formatVersion: 1,
    project: {
      name: detail.name,
      description: detail.description,
      boardType: detail.boardType,
      engine: detail.engine,
    },
    diagram: detail.diagram,
    files: detail.files,
  };
}

/** 导入 JSON 包：同 createProject（bundle 已在路由层校验），随后写入包内 diagram 与文件 */
export function importProjectBundle(db: Db, bundle: ProjectBundle): ProjectMeta {
  const meta = createProject(db, {
    name: bundle.project.name,
    description: bundle.project.description,
    boardType: bundle.project.boardType,
    engine: bundle.project.engine,
  });
  return updateProject(db, meta.id, { diagram: bundle.diagram, files: bundle.files });
}
