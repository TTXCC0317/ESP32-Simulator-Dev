import { expect, test } from '@playwright/test';

/**
 * 场景三（06-§7 静态资源隔离，P1 终验前必跑）：
 * SQLite 数据库与构建产物目录不得经 HTTP 泄露（404，而非下载）。
 * 注：HTTP 客户端会把 /a/../b 规范化为 /b，故穿越用例以 %2e%2e 编码发出，
 * 同时覆盖规范化后的直访形式（两种攻击面等价 404）。
 *
 * 拓扑差异（M6 实测）：/api/* 经 4173 vite preview 代理到后端；/data/* 直访在
 * preview 侧会命中 SPA fallback（回退 index.html，200 但不含 DB 内容，非泄露）。
 * 生产部署由 Fastify 托管 dist（app.ts fastifyStatic），隔离边界在后端——
 * 直访用例直接打 3001（生产拓扑语义），不走 preview。
 */
const API_BASE = 'http://127.0.0.1:3001';

test.describe('静态资源隔离', () => {
  test('编码穿越 /api/projects/%2e%2e/data/simulator.db → 404', async ({ request }) => {
    const r = await request.get('/api/projects/%2e%2e/data/simulator.db');
    expect(r.status()).toBe(404);
  });

  test('后端静态：规范化直访 /data/simulator.db → 404', async ({ request }) => {
    const r = await request.get(`${API_BASE}/data/simulator.db`);
    expect(r.status()).toBe(404);
  });

  test('后端静态：构建产物目录 /data/builds/ → 404', async ({ request }) => {
    const r = await request.get(`${API_BASE}/data/builds/`);
    expect(r.status()).toBe(404);
  });
});
