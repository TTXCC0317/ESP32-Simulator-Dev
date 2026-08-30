import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config/schema';
import type { Db } from './db/client';
import { healthRoutes, type HealthRoutesOptions } from './routes/health';
import { catalogRoutes } from './routes/catalog';
import { projectRoutes } from './routes/projects';
import { buildRoutes } from './routes/builds';
import { wsGatewayRoutes } from './routes/ws-gateway';
import { BuildService, type BuildRunner } from './services/build.service';
import { QemuManager, type SpawnQemuFn } from './services/qemu.manager';
import { loadCatalog, importCatalog, type CatalogData } from './services/catalog.service';
import { seedExamples } from './db/seed';
import { probeTools, type ToolsStatus } from './services/tools-probe';
import { appRoot } from './utils/app-root';
import { HttpError } from './utils/http-error';

/**
 * Fastify 实例与插件注册（《02-实施方案》§3.8 N14 中间件链）
 *
 * 注册顺序（串行 await，禁止乱序）：
 *   CORS → pino(logger 由实例携带) → rate-limit → errorHandler/notFound → 路由 → websocket → static
 *   （errorHandler 必须先于路由注册：fastify 4 子上下文在 register 时捕获 handler）
 *
 * M1 范围：health 路由 + 链条骨架；WS 网关业务、静态托管 dist 生成物随 M4/M8 落地。
 * traceId：01-§5.2.1（req-<uuid8>，同步写入错误响应；请求日志关联用 reqId）。
 */

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  /** 覆盖工具链探测实现（测试注入 stub；缺省启动时执行一次真实探测） */
  probe?: (cfg: AppConfig['tools']) => Promise<ToolsStatus>;
  /** 覆盖元件目录（测试注入；缺省从 <repoRoot>/config 读取并导入 DB + 种子示例） */
  catalog?: CatalogData;
  /** 覆盖编译执行器（测试注入 stub；缺省 execa 调 arduino-cli/esptool） */
  buildRunner?: BuildRunner;
  /** 覆盖 QEMU 进程 spawn（测试注入 stub；缺省 node child_process.spawn） */
  qemuSpawn?: SpawnQemuFn;
}

export function makeTraceId(): string {
  return `req-${randomUUID().slice(0, 8)}`;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db } = opts;

  const fastify = Fastify({
    logger: {
      level: config.log.level,
      // M3 按 02-§1.4/§3.7 接 pino-roll 文件轮转（logs/server.log 10MB×5）；M1 先 stdout
    },
    bodyLimit: config.limits.maxFileBytes,
  });

  fastify.decorateRequest('traceId', '');
  fastify.addHook('onRequest', async (req) => {
    req.traceId = makeTraceId();
  });

  // 1) CORS：开发期允许 Vite 5173 源（生产同源托管，无需跨源）
  await fastify.register(cors, { origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] });

  // 2) rate-limit：M1 仅注册框架（global:false，不设具体规则——REST 全局限流数值文档未定，
  //    不发明；M4 WS 网关按 config.ws.msgRateLimitPerSec 落地）
  await fastify.register(rateLimit, { global: false });

  // 3) 统一错误响应（01-§5.2.1 envelope + 错误码枚举）。
  //    必须在路由插件注册之前设置：fastify 4 子上下文在 register 时捕获 error/notFound
  //    handler，后置设置不会作用于已注册路由（M3 回归修复，02-§3.8 N14 已同步修订）。
  fastify.setErrorHandler((err: FastifyError, req, reply: FastifyReply) => {
    const traceId = req.traceId;
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      req.log.error({ err, traceId }, 'unhandled error');
      void reply.status(500).send({
        error: { code: 'INTERNAL', message: 'Internal Server Error', traceId },
      });
      return;
    }
    // 4xx：业务错误（HttpError）透传错误码；zod/框架错误归一为 BAD_REQUEST
    const code = err instanceof HttpError ? err.code : 'BAD_REQUEST';
    void reply.status(statusCode).send({
      error: { code, message: err.message, traceId },
    });
  });

  fastify.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.url} not found`,
        traceId: req.traceId,
      },
    });
  });

  // 4) REST 路由
  const toolsAtBoot = await (opts.probe ?? probeTools)(config.tools);
  const healthOpts: HealthRoutesOptions = { config, db, toolsAtBoot, probe: opts.probe };
  await fastify.register(healthRoutes, healthOpts);

  // 5) catalog 导入（M3）：config JSON → zod 校验（fail-fast）→ parts_catalog/board_pinmaps + 示例种子
  const catalog = opts.catalog ?? loadCatalog(join(appRoot(), 'config'));
  importCatalog(db, catalog);
  seedExamples(db);
  await fastify.register(catalogRoutes, { db, catalog });
  await fastify.register(projectRoutes, { db, config, catalog });

  // 5.5) 引擎B 服务（M4）：编译队列 + QEMU 会话管理器（REST build 路由同步注册）
  const buildService = new BuildService({ db, config, run: opts.buildRunner });
  const qemuManager = new QemuManager({ config, spawn: opts.qemuSpawn });
  // 启动时清理异常残留的 flash 会话目录（06-§4：>cleanupOrphanedAfterHours 扫描删除；fail-safe）
  try {
    const removed = qemuManager.cleanupOrphanedDirs();
    if (removed > 0) fastify.log.info({ removed }, 'cleaned orphaned flash session dirs');
  } catch {
    // 清理失败不阻塞启动
  }
  await fastify.register(buildRoutes, { db, config, builds: buildService });

  // 6) websocket 插件（M4 会话网关使用；M1 先完成链条注册与 payload 上限。
  //    @fastify/websocket v10 起 ws server 选项收敛到 options 子对象）
  await fastify.register(websocket, { options: { maxPayload: config.ws.maxMsgBytes } });

  // 6.5) WS 会话网关（03-§7.3 状态机；必须在 websocket 插件之后注册）
  await fastify.register(wsGatewayRoutes, {
    db,
    config,
    builds: buildService,
    qemu: qemuManager,
  });

  // 暴露给入口层：graceful shutdown 时回收 QEMU 进程（06-§4 无孤儿进程）
  fastify.decorate('qemuManager', qemuManager);

  // 7) static：仅在 web 产物存在时挂载（dev 期由 Vite 5173 服务前端）
  const distDir = resolve(process.cwd(), config.server.staticDistPath);
  if (existsSync(distDir)) {
    await fastify.register(fastifyStatic, { root: distDir });
  }

  return fastify;
}

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string;
  }
  interface FastifyInstance {
    qemuManager: QemuManager;
  }
}
