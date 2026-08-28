import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db/client';
import type { AppConfig } from '../config/schema';
import { probeTools, type ToolsStatus } from '../services/tools-probe';

/**
 * 健康检查路由（01-§5.2：`/api/health` 与 `/api/health/tools` 无需鉴权，启动期前端探测用）
 */

export interface HealthRoutesOptions {
  config: AppConfig;
  db: Db;
  /** /api/health 展示的启动时工具链缓存（避免每次健康检查拉起子进程） */
  toolsAtBoot: ToolsStatus;
  /** 可注入的探测实现（默认 probeTools 实时拉起子进程；测试注入 stub） */
  probe?: (cfg: AppConfig['tools']) => Promise<ToolsStatus>;
}

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (fastify, opts) => {
  const { config, db, toolsAtBoot } = opts;
  const probe = opts.probe ?? ((cfg) => probeTools(cfg));

  fastify.get('/api/health', async () => {
    // 01-§5.2：uptime / db / 工具链概览
    return {
      status: 'ok',
      uptimeSec: Math.floor(process.uptime()),
      db: {
        ok: db.open,
        path: config.db.path,
        wal: config.db.wal,
      },
      engines: {
        engineA: true, // 引擎A 纯前端 WASM，与后端工具链无关
        engineB: toolsAtBoot.arduinoCli.ok && toolsAtBoot.qemu.ok,
      },
    };
  });

  fastify.get('/api/health/tools', async (): Promise<ToolsStatus> => {
    // 02-§1.3 结构：node / git / arduinoCli(+esp32Core) / esptool / qemu；实时探测
    return probe(config.tools);
  });
};
