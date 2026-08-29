import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/schema';
import type { Db } from '../db/client';
import { HttpError, notFound } from '../utils/http-error';
import type { BuildService, BuildRecord } from '../services/build.service';

/**
 * 编译 REST（01-§5.2）：
 * - POST /api/build     提交编译 {projectId, toolchain} → {buildId}
 * - GET  /api/builds/:id 查询状态/日志/产物
 */

const submitBodySchema = z.object({
  projectId: z.string().min(1),
  toolchain: z.enum(['arduino', 'esp-idf']).default('arduino'),
});

export interface BuildRoutesOptions {
  config: AppConfig;
  db: Db;
  builds: BuildService;
}

function recordToResponse(rec: BuildRecord, logs: string[]) {
  return {
    id: rec.id,
    projectId: rec.projectId,
    toolchain: rec.toolchain,
    status: rec.status,
    artifact: rec.artifact,
    pinned: rec.pinned,
    createdAt: rec.createdAt,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    logs,
  };
}

export async function buildRoutes(
  fastify: FastifyInstance,
  opts: BuildRoutesOptions,
): Promise<void> {
  const { builds } = opts;

  fastify.post('/api/build', async (req, reply) => {
    const parsed = submitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, 'VALIDATION_FAILED', parsed.error.message);
    }
    const { projectId, toolchain } = parsed.data;
    try {
      const { buildId } = builds.submit(projectId, toolchain);
      req.log.info({ buildId, projectId, traceId: req.traceId }, 'build submitted');
      return await reply.status(202).send({ buildId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('不存在')) throw notFound(msg);
      throw new HttpError(400, 'BUILD_REJECTED', msg);
    }
  });

  fastify.get('/api/builds/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = builds.status(id);
    if (!rec) throw notFound(`编译任务不存在：${id}`);
    return await reply.send(recordToResponse(rec, builds.logs(id)));
  });
}
