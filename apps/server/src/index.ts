import { loadConfig } from './config/loader';
import { openDatabase } from './db/client';
import { runMigrations } from './db/migrator';
import { buildApp } from './app';

/**
 * 服务端入口：加载配置 → 打开 SQLite → 跑迁移 → 启动 HTTP（01-§5.1 分层）
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.db);
  const { applied, total } = runMigrations(db);

  const app = await buildApp({ config, db });
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
