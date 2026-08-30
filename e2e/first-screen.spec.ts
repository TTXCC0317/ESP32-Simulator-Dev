import { expect, test } from '@playwright/test';

/**
 * 场景一（02-§3.5）：生产构建首屏可交互 ≤3s。
 * 口径：goto（load 事件）→ 工程列表标题可见；生产构建（vite build + preview）。
 */
test('生产构建首屏 ≤3s', async ({ page }) => {
  const t0 = Date.now();
  await page.goto('/');
  // 3s 内不可见即 toBeVisible 超时失败（与预算一致）
  await expect(page.getByRole('heading', { name: 'ESP32 Simulator' })).toBeVisible({
    timeout: 3_000,
  });
  const elapsed = Date.now() - t0;
  test.info().annotations.push({ type: 'first-screen', description: `${elapsed}ms` });
  expect(elapsed).toBeLessThanOrEqual(3_000);
});
