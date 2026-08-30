import { expect, test } from '@playwright/test';

/**
 * 场景二（02-§3.5）：画布交互帧率 ≥30fps。
 * 口径：拖拽 Konva 画布（指针平移）期间收集 rAF 帧间隔，中位数 ≤33.4ms。
 * headless Chromium 以 60Hz BeginFrame 驱动，空闲中位 ≈16.7ms；主线程卡顿即中位劣化。
 */
test('画布拖拽帧率 ≥30fps', async ({ page }) => {
  const res = await page.request.post('/api/projects', { data: { name: 'e2e-fps' } });
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };

  await page.goto(`/workbench/${id}`);
  const canvas = page.locator('.konvajs-content').first();
  await canvas.waitFor({ state: 'visible', timeout: 30_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('画布无边界（konvajs-content 未布局）');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // 采样期间同步拖拽：180 帧 rAF 时间戳 → 帧间隔数组
  const deltasPromise = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const stamps: number[] = [];
        const loop = (t: number) => {
          stamps.push(t);
          if (stamps.length < 181) requestAnimationFrame(loop);
          else resolve(stamps.slice(1).map((v, i) => v - stamps[i]!));
        };
        requestAnimationFrame(loop);
      }),
  );
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) {
    await page.mouse.move(cx + i * 2, cy + i * 2);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  const deltas = await deltasPromise;

  expect(deltas.length).toBeGreaterThanOrEqual(120);
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  test.info().annotations.push({ type: 'fps-median', description: `${median}ms` });
  expect(median).toBeLessThanOrEqual(33.4);
});
