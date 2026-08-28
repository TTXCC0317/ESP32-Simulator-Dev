import { describe, it, expect, afterEach } from 'vitest';
import { appConfigSchema } from '../config/schema';
import { openDatabase, type Db } from '../db/client';
import { buildApp, type BuildAppOptions } from '../app';
import type { ToolsStatus } from '../services/tools-probe';

/**
 * L3：health 路由 fastify.inject 集成测试（02-§3.1 分层）。
 * 探测实现注入 stub，不拉起真实子进程；数据库用内存库。
 */

const stubTools: ToolsStatus = {
  node: 'v22.23.2',
  git: { ok: true, version: '2.45.0' },
  arduinoCli: { ok: true, version: '1.0.4', esp32Core: '3.1.3' },
  esptool: { ok: false, reason: 'config.app.json 中 tools.esptool 未配置' },
  qemu: { ok: false, reason: 'config.app.json 中 tools.qemuXtensa 未配置' },
};

const apps: Array<{ app: Awaited<ReturnType<typeof buildApp>>; db: Db }> = [];

afterEach(async () => {
  while (apps.length) {
    const { app, db } = apps.pop() as { app: Awaited<ReturnType<typeof buildApp>>; db: Db };
    await app.close();
    db.close();
  }
});

async function buildTestApp() {
  const config = appConfigSchema.parse({});
  const db = openDatabase({ path: ':memory:', wal: false });
  const opts: BuildAppOptions = { config, db, probe: async () => stubTools };
  const app = await buildApp(opts);
  apps.push({ app, db });
  return { app, db };
}

describe('GET /api/health（01-§5.2）', () => {
  it('返回 ok、db 概览与引擎可用性', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.uptimeSec).toBeTypeOf('number');
    expect(body.db).toEqual({ ok: true, path: 'data/simulator.db', wal: true });
    expect(body.engines.engineA).toBe(true);
    // stub 中 qemu 不可用 → 引擎B 不可用
    expect(body.engines.engineB).toBe(false);
  });
});

describe('GET /api/health/tools（02-§1.3 结构）', () => {
  it('返回注入 stub 的完整探测结构', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health/tools' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stubTools);
  });
});

describe('404 envelope（01-§5.2.1）', () => {
  it('未知路由返回 NOT_FOUND + traceId', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/definitely-not-exist' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('/api/definitely-not-exist');
    expect(body.error.traceId).toMatch(/^req-[0-9a-f]{8}$/);
  });
});
