import { join } from 'node:path';
import { loadConfig } from './config/loader';
import { openDatabase } from './db/client';
import { runMigrations } from './db/migrator';
import { buildApp } from './app';
import { appRoot } from './utils/app-root';

/**
 * 服务端入口：加载配置 → 打开 SQLite → 跑迁移 → 启动 HTTP（01-§5.1 分层）
 *
 * config/ 与 catalog 锚定仓库根（appRoot 探测），data/ 相对 cwd（单机开发固定 apps/server/data）。
 */
async function main(): Promise<void> {
  const config = loadConfig(join(appRoot(), 'config', 'app.json'));
  const db = openDatabase(config.db);
  const { applied, total } = runMigrations(db);

  const app = await buildApp({ config, db });

  // graceful shutdown（06-§4：进程表无孤儿）：信号 → 关 HTTP → 回收 QEMU → 退出
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => app.qemuManager.disposeAll())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port: config.server.port, host: config.server.host });
  app.log.info(
    {
      migrations: { appliedNow: applied, total },
      url: `http://${config.server.host}:${config.server.port}`,
    },
    'server started',
  );
}

main().catch((err: unknown) => {
  // 启动失败（配置缺失/端口占用等）：stderr 直出后退出，避免带病运行
  console.error('[server] 启动失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
