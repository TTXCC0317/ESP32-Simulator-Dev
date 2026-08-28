import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config/schema';
import type { Db } from './db/client';
import { healthRoutes, type HealthRoutesOptions } from './routes/health';
import { probeTools, type ToolsStatus } from './services/tools-probe';

/**
 * Fastify 实例与插件注册（《02-实施方案》§3.8 N14 中间件链）
 *
 * 注册顺序（串行 await，禁止乱序）：
 *   CORS → pino(logger 由实例携带) → rate-limit → 路由 → websocket → errorHandler → static
 *
 * M1 范围：health 路由 + 链条骨架；WS 网关业务、静态托管 dist 生成物随 M4/M8 落地。
 * traceId：01-§5.2.1（req-<uuid8>，同步写入错误响应；请求日志关联用 reqId）。
 */

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  /** 覆盖工具链探测实现（测试注入 stub；缺省启动时执行一次真实探测） */
  probe?: (cfg: AppConfig['tools']) => Promise<ToolsStatus>;
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

  // 3) REST 路由
  const toolsAtBoot = await (opts.probe ?? probeTools)(config.tools);
  const healthOpts: HealthRoutesOptions = { config, db, toolsAtBoot, probe: opts.probe };
  await fastify.register(healthRoutes, healthOpts);

  // 4) websocket 插件（M4 会话网关使用；M1 先完成链条注册与 payload 上限。
  //    @fastify/websocket v10 起 ws server 选项收敛到 options 子对象）
  await fastify.register(websocket, { options: { maxPayload: config.ws.maxMsgBytes } });

  // 5) 统一错误响应（01-§5.2.1 envelope + 错误码枚举）
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
    // 4xx：zod/参数校验等框架错误归一为 BAD_REQUEST；业务错误码随路由抛出时透传
    const code = err.code && /^[A-Z_]+$/.test(err.code) ? err.code : 'BAD_REQUEST';
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

  // 6) static：仅在 web 产物存在时挂载（dev 期由 Vite 5173 服务前端）
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
}
