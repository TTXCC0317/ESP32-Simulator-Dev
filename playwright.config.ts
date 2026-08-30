import { defineConfig } from '@playwright/test';

/**
 * L4 E2E（02-§3.1 测试分层；M6 m6-4 三场景）：
 * - first-screen：生产构建首屏可交互 ≤3s（02-§3.5）；
 * - fps：画布拖拽帧率 ≥30fps（02-§3.5）；
 * - static-isolation：路径穿越与 data/ 直访 404（06-§7，P1 终验前必跑）。
 *
 * 服务拓扑：API（3001，tsx watch）+ 生产构建 preview（4173，vite preview + 代理）。
 * e2e.yml（里程碑验收前手动 dispatch）在 CI 上运行本配置。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @esp32-sim/server dev',
      port: 3001,
      reuseExistingServer: true,
      timeout: 90_000,
    },
    {
      command:
        'pnpm --filter @esp32-sim/web build && pnpm --filter @esp32-sim/web preview --port 4173 --strictPort --host 127.0.0.1',
      port: 4173,
      reuseExistingServer: true,
      timeout: 240_000,
    },
  ],
});
