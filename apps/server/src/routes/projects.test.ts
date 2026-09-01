import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfigSchema } from '../config/schema';
import { openDatabase } from '../db/client';
import { runMigrations } from '../db/migrator';
import { buildApp, type BuildAppOptions } from '../app';
import type { ToolsStatus } from '../services/tools-probe';
import type { ProjectDetail, ProjectMeta } from '@esp32-sim/shared';

/**
 * L3：projects/catalog REST 全端点正反向（02-§4 M3 测试项）：
 * 404 / 400 / 413 / 422 / 路径穿越拒绝 / 保存→重启→数据完整（WAL 文件库）。
 */

const stubTools: ToolsStatus = {
  node: 'v22.23.2',
  git: { ok: true, version: '2.45.0' },
  arduinoCli: { ok: false, reason: 'stub' },
  esptool: { ok: false, reason: 'stub' },
  qemu: { ok: false, reason: 'stub' },
};

const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop() as () => void;
    try {
      await fn();
    } catch {
      // 已关闭的资源重复清理可忽略
    }
  }
});

async function buildTestApp(dbPath: ':memory:' | string = ':memory:', wal = false) {
  const config = appConfigSchema.parse({});
  const db = openDatabase({ path: dbPath, wal });
  runMigrations(db);
  const opts: BuildAppOptions = { config, db, probe: async () => stubTools };
  const app = await buildApp(opts);
  cleanups.push(() => {
    void app.close();
    db.close();
  });
  return { app, db, config };
}

async function createProject(
  app: Awaited<ReturnType<typeof buildApp>>,
  body: Record<string, unknown>,
): Promise<ProjectMeta> {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: body });
  expect(res.statusCode).toBe(201);
  return res.json() as ProjectMeta;
}

describe('catalog 只读端点（01-§5.2）', () => {
  it('GET /api/parts 返回全部元件且带引脚定义（P1 8 类 + M8 I2C/SPI 设备）', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/parts' });
    expect(res.statusCode).toBe(200);
    const parts = res.json() as Array<{ type: string; category: string; pins: unknown[] }>;
    expect(parts.map((p) => p.type).sort()).toEqual([
      'board-esp32-devkit-c-v4',
      'wokwi-bh1750',
      'wokwi-buzzer',
      'wokwi-dht22',
      'wokwi-led',
      'wokwi-mpu6050',
      'wokwi-potentiometer',
      'wokwi-pushbutton',
      'wokwi-resistor',
      'wokwi-rgb-led',
      'wokwi-servo',
      'wokwi-slide-switch',
      'wokwi-w25q32',
    ]);
    for (const p of parts) expect(p.pins.length, p.type).toBeGreaterThan(0);
  });

  it('GET /api/boards 返回板卡与左右列引脚映射', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/boards' });
    expect(res.statusCode).toBe(200);
    const boards = res.json() as Array<{ type: string; pins: Array<{ col: string }> }>;
    expect(boards).toHaveLength(1);
    expect(boards[0]?.type).toBe('esp32-devkit-c-v4');
    expect(boards[0]?.pins.some((p) => p.col === 'L')).toBe(true);
    expect(boards[0]?.pins.some((p) => p.col === 'R')).toBe(true);
  });

  it('GET /api/examples 列出内置 blink 示例', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/examples' });
    expect(res.statusCode).toBe(200);
    const examples = res.json() as Array<{ id: string; name: string }>;
    expect(examples.map((e) => e.id)).toContain('blink');
  });
});

describe('POST /api/projects', () => {
  it('空白创建 201 并出现在列表', async () => {
    const { app } = await buildTestApp();
    const meta = await createProject(app, { name: 'demo' });
    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    const items = list.json() as ProjectMeta[];
    expect(items.map((p) => p.id)).toContain(meta.id);
  });

  it('从示例创建 201（diagram/files 实例化）', async () => {
    const { app } = await buildTestApp();
    const meta = await createProject(app, { name: 'b1', exampleId: 'blink' });
    const detail = await app.inject({ method: 'GET', url: `/api/projects/${meta.id}` });
    const body = detail.json() as ProjectDetail;
    expect(detail.statusCode).toBe(200);
    expect(body.diagram.boardType).toBe('board-esp32-devkit-c-v4');
    expect(body.files.length).toBeGreaterThan(0);
  });

  it('未知板卡 422；非法请求体 400；示例不存在 404', async () => {
    const { app } = await buildTestApp();
    const badBoard = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'x', boardType: 'esp8266' },
    });
    expect(badBoard.statusCode).toBe(422);
    expect(badBoard.json().error.code).toBe('VALIDATION_FAILED');

    const badBody = await app.inject({ method: 'POST', url: '/api/projects', payload: {} });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json().error.code).toBe('BAD_REQUEST');

    const noExample = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'x', exampleId: 'nope' },
    });
    expect(noExample.statusCode).toBe(404);
    expect(noExample.json().error.code).toBe('NOT_FOUND');
  });
});

describe('PUT /api/projects/:id 边界（06-§3/§6）', () => {
  it('正常保存 diagram + files → 200，读取一致', async () => {
    const { app } = await buildTestApp();
    const meta = await createProject(app, { name: 'demo' });
    const diagram = {
      formatVersion: 1,
      boardType: 'board-esp32-devkit-c-v4',
      parts: [
        { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 60, top: 60, rotate: 0, attrs: {} },
        { id: 'led1', type: 'wokwi-led', left: 420, top: 120, rotate: 0, attrs: { color: 'red' } },
      ],
      connections: [
        { id: 'w1', source: 'esp:GPIO4', target: 'led1:A', color: 'green', path: [] },
        { id: 'w2', source: 'led1:C', target: 'esp:GND.1', color: 'black', path: [] },
      ],
      serialMonitor: { baudrate: 115200 },
    };
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${meta.id}`,
      payload: { diagram, files: [{ path: 'main.py', content: 'print(1)' }] },
    });
    expect(res.statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/api/projects/${meta.id}` });
    const body = detail.json() as ProjectDetail;
    expect(body.diagram.connections).toHaveLength(2);
    expect(body.files).toEqual([{ path: 'main.py', content: 'print(1)' }]);
  });

  it('未知元件类型/非法 PinRef → 422 VALIDATION_FAILED', async () => {
    const { app } = await buildTestApp();
    const meta = await createProject(app, { name: 'demo' });
    const base = {
      formatVersion: 1,
      boardType: 'board-esp32-devkit-c-v4',
      parts: [
        { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 0, top: 0, rotate: 0, attrs: {} },
      ],
      connections: [],
      serialMonitor: { baudrate: 115200 },
    };
    const unknownType = await app.inject({
      method: 'PUT',
      url: `/api/projects/${meta.id}`,
      payload: {
        diagram: {
          ...base,
          parts: [
            ...base.parts,
            { id: 'x', type: 'wokwi-ghost', left: 0, top: 0, rotate: 0, attrs: {} },
          ],
        },
      },
    });
    expect(unknownType.statusCode).toBe(422);
    expect(unknownType.json().error.code).toBe('VALIDATION_FAILED');

    const badPin = await app.inject({
      method: 'PUT',
      url: `/api/projects/${meta.id}`,
      payload: {
        diagram: {
          ...base,
          connections: [
            { id: 'w1', source: 'esp:NOPE', target: 'esp:GND.1', color: 'red', path: [] },
          ],
        },
      },
    });
    expect(badPin.statusCode).toBe(422);
  });

  it('文件路径穿越 → 400 PATH_TRAVERSAL', async () => {
    const { app } = await buildTestApp();
    const meta = await createProject(app, { name: 'demo' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${meta.id}`,
      payload: { files: [{ path: '../../etc/passwd', content: 'x' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PATH_TRAVERSAL');
  });

  it('文件数超 50 → 413；单文件超 1MB → 413', async () => {
    const { app, config } = await buildTestApp();
    const meta = await createProject(app, { name: 'demo' });
    const many = Array.from({ length: config.limits.filesPerProject + 1 }, (_, i) => ({
      path: `f${i}.py`,
      content: '',
    }));
    const overCount = await app.inject({
      method: 'PUT',
      url: `/api/projects/${meta.id}`,
      payload: { files: many },
    });
    expect(overCount.statusCode).toBe(413);
    expect(overCount.json().error.code).toBe('OVER_LIMIT');

    const big = await app.inject({
      method: 'PUT',
      url: `/api/projects/${meta.id}`,
      payload: { files: [{ path: 'big.py', content: 'x'.repeat(config.limits.maxFileBytes + 1) }] },
    });
    expect(big.statusCode).toBe(413);
  });

  it('URL 路径穿越兜底：通配子路径归一 404；../.. 被 HTTP 客户端归一化（06-§6.1）', async () => {
    const { app } = await buildTestApp();
    // WHATWG URL 解析会把 ../.. 与 %2e%2e 归一化（inject 亦然），原始路径到不了服务端；
    // 服务端仍保留通配路由的 '..' 段 → 400 PATH_TRAVERSAL 兜底（针对原始 TCP 请求，防御纵深）。
    // 此处验证两条可达路径：未知通配子路径与归一化后的未知路由均返回 404 envelope。
    const unknownSub = await app.inject({ method: 'GET', url: '/api/projects/unknown/sub' });
    expect(unknownSub.statusCode).toBe(404);
    expect(unknownSub.json().error.code).toBe('NOT_FOUND');

    const normalized = await app.inject({
      method: 'GET',
      url: '/api/projects/../../etc/passwd/files/main.py',
    });
    expect(normalized.statusCode).toBe(404);
    expect(normalized.json().error.code).toBe('NOT_FOUND');
    // 归一化后不该泄露 projects 之外的内容
    expect(normalized.json().error.message).not.toContain('..');
  });
});

describe('复制 / 删除 / 导出 / 导入', () => {
  it('复制 → 201 名称含“副本”；删除 → 204 后 404', async () => {
    const { app } = await buildTestApp();
    const meta = await createProject(app, { name: 'demo', exampleId: 'blink' });
    const copy = await app.inject({ method: 'POST', url: `/api/projects/${meta.id}/copy` });
    expect(copy.statusCode).toBe(201);
    expect((copy.json() as ProjectMeta).name).toBe('demo 副本');

    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${meta.id}` });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: `/api/projects/${meta.id}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe('NOT_FOUND');
  });

  it('导出 JSON 包 → 导入还原（formatVersion:1）', async () => {
    const { app } = await buildTestApp();
    const meta = await createProject(app, { name: 'roundtrip', exampleId: 'blink' });
    const exp = await app.inject({ method: 'GET', url: `/api/projects/${meta.id}/export` });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-disposition']).toContain('attachment');
    const bundle = exp.json() as Record<string, unknown>;
    expect(bundle.formatVersion).toBe(1);

    const imp = await app.inject({ method: 'POST', url: '/api/projects/import', payload: bundle });
    expect(imp.statusCode).toBe(201);
    const restored = await app.inject({
      method: 'GET',
      url: `/api/projects/${(imp.json() as ProjectMeta).id}`,
    });
    const body = restored.json() as ProjectDetail;
    expect(body.name).toBe('roundtrip');
    expect(body.diagram).toEqual(bundle.diagram);
  });

  it('导入未知板卡 422；包结构非法 400', async () => {
    const { app } = await buildTestApp();
    const badBoard = await app.inject({
      method: 'POST',
      url: '/api/projects/import',
      payload: {
        formatVersion: 1,
        project: { name: 'x', description: '', boardType: 'esp8266', engine: 'micropython-wasm' },
        diagram: {
          formatVersion: 1,
          boardType: 'board-esp8266',
          parts: [],
          connections: [],
          serialMonitor: { baudrate: 115200 },
        },
        files: [],
      },
    });
    expect(badBoard.statusCode).toBe(422);

    const badBundle = await app.inject({
      method: 'POST',
      url: '/api/projects/import',
      payload: { formatVersion: 2 },
    });
    expect(badBundle.statusCode).toBe(400);
  });
});

describe('持久化验收：保存→重建 app（模拟重启）→数据完整（WAL）', () => {
  it('文件库重启后工程与文件完整', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wal-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbFile = join(dir, 'sim.db');

    const first = await buildTestApp(dbFile, true);
    const meta = await createProject(first.app, { name: 'persist', exampleId: 'blink' });
    await first.app.inject({
      method: 'PUT',
      url: `/api/projects/${meta.id}`,
      payload: { files: [{ path: 'main.py', content: 'print("v2")' }] },
    });
    await first.app.close();
    first.db.close();

    // “重启进程”：新 app + 同一库文件
    const second = await buildTestApp(dbFile, true);
    const detail = await second.app.inject({ method: 'GET', url: `/api/projects/${meta.id}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as ProjectDetail;
    expect(body.name).toBe('persist');
    expect(body.files).toEqual([{ path: 'main.py', content: 'print("v2")' }]);

    // 迁移幂等：重启后 _migrations 仍只有 1 条
    const migs = second.db.prepare('SELECT COUNT(*) n FROM _migrations').get() as { n: number };
    expect(migs.n).toBe(1);
  });
});
