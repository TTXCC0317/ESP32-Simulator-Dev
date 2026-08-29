import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodType, ZodError } from 'zod';
import {
  createProjectSchema,
  projectBundleSchema,
  updateProjectSchema,
  validateCircuitDoc,
  type CircuitDoc,
  type ValidationContext,
} from '@esp32-sim/shared';
import type { Db } from '../db/client';
import type { AppConfig } from '../config/schema';
import type { CatalogData } from '../services/catalog.service';
import { buildValidationContext } from '../services/catalog.service';
import {
  ExampleNotFoundError,
  ProjectNotFoundError,
  copyProject,
  createProject,
  deleteProject,
  exportProject,
  getProjectDetail,
  importProjectBundle,
  listProjects,
  updateProject,
} from '../services/projects.service';
import { normalizeProjectPath } from '../utils/project-path';
import {
  badRequest,
  notFound,
  overLimit,
  pathTraversal,
  validationFailed,
} from '../utils/http-error';

/**
 * 工程 REST（01-§5.2）：CRUD / 复制 / 导出 / 导入 + 路径穿越与规模边界（06-§3/§6）
 *
 * 校验分层：zod 结构（400 BAD_REQUEST）→ 规模上限（413 OVER_LIMIT）
 * → 电路业务校验（422 VALIDATION_FAILED）→ 持久化（projects.service）。
 */

export interface ProjectRoutesOptions {
  db: Db;
  config: AppConfig;
  catalog: CatalogData;
}

function zodIssuesToMessage(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}

function parseBody<T>(schema: ZodType<T>, req: FastifyRequest): T {
  const r = schema.safeParse(req.body);
  if (!r.success) {
    throw badRequest(`请求体校验失败: ${zodIssuesToMessage(r.error)}`);
  }
  return r.data;
}

export const projectRoutes: FastifyPluginAsync<ProjectRoutesOptions> = async (fastify, opts) => {
  const { db, config, catalog } = opts;
  const limits = config.limits;
  const boardTypes = new Set(catalog.boards.map((b) => b.type));
  let ctx: ValidationContext | null = null;
  const validationCtx = (): ValidationContext => (ctx ??= buildValidationContext(catalog));

  function assertBoardType(boardType: string): void {
    if (!boardTypes.has(boardType)) {
      throw validationFailed(`未知板卡类型: ${boardType}`);
    }
  }

  /** diagram 规模 + 电路业务校验（06-§3 diagram 2MB / 元件 120 / 连线 300） */
  function assertDiagram(diagram: CircuitDoc): void {
    if (JSON.stringify(diagram).length > limits.diagramJsonMaxBytes) {
      throw overLimit(`diagram.json 超过 ${limits.diagramJsonMaxBytes} 字节上限`);
    }
    const v = validateCircuitDoc(diagram, validationCtx());
    if (!v.ok) {
      const first = v.errors[0]?.message ?? '电路校验失败';
      throw validationFailed(`diagram 校验失败: ${first}`);
    }
  }

  /** 文件规模与路径校验（06-§3：单文件 1MB / 50 个；06-§6 防穿越） */
  function assertFiles(
    files: Array<{ path: string; content: string }>,
  ): Array<{ path: string; content: string }> {
    if (files.length > limits.filesPerProject) {
      throw overLimit(`文件数 ${files.length} 超过上限 ${limits.filesPerProject}`);
    }
    return files.map((f) => {
      const normalized = normalizeProjectPath(f.path);
      if (!normalized) {
        throw pathTraversal(`非法文件路径: ${f.path}`);
      }
      if (Buffer.byteLength(f.content, 'utf8') > limits.maxFileBytes) {
        throw overLimit(`文件 ${normalized} 超过单文件 ${limits.maxFileBytes} 字节上限`);
      }
      return { path: normalized, content: f.content };
    });
  }

  fastify.get('/api/projects', async () => {
    return listProjects(db);
  });

  fastify.post('/api/projects', async (req, reply) => {
    const body = parseBody(createProjectSchema, req);
    if (body.boardType !== undefined) assertBoardType(body.boardType);
    try {
      const meta = createProject(db, body);
      return await reply.status(201).send(meta);
    } catch (err) {
      if (err instanceof ExampleNotFoundError) {
        throw notFound(`示例不存在: ${body.exampleId}`);
      }
      throw err;
    }
  });

  fastify.get('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const detail = getProjectDetail(db, id);
    if (!detail) throw notFound(`Project ${id} not found`);
    return detail;
  });

  fastify.put('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(updateProjectSchema, req);
    if (body.boardType !== undefined) assertBoardType(body.boardType);
    if (body.diagram !== undefined) assertDiagram(body.diagram);
    if (body.files !== undefined) body.files = assertFiles(body.files);
    try {
      return updateProject(db, id, body);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(`Project ${id} not found`);
      throw err;
    }
  });

  fastify.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deleteProject(db, id)) throw notFound(`Project ${id} not found`);
    return await reply.status(204).send();
  });

  fastify.post('/api/projects/:id/copy', async (req, reply) => {
    const { id } = req.params as { id: string };
    const meta = copyProject(db, id);
    if (!meta) throw notFound(`Project ${id} not found`);
    return await reply.status(201).send(meta);
  });

  fastify.get('/api/projects/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const bundle = exportProject(db, id);
    if (!bundle) throw notFound(`Project ${id} not found`);
    void reply.header('Content-Disposition', `attachment; filename="project-${id}.json"`);
    return bundle;
  });

  fastify.post('/api/projects/import', async (req, reply) => {
    const body = parseBody(projectBundleSchema, req);
    assertBoardType(body.project.boardType.replace(/^board-/, ''));
    assertDiagram(body.diagram);
    const meta = importProjectBundle(db, body);
    return await reply.status(201).send(meta);
  });

  // 路径穿越兜底（06-§6.1 L3 用例）：/api/projects/../../xxx 命中通配，
  // 含 ".." 段返回 400 PATH_TRAVERSAL，其余归一为 404
  fastify.all('/api/projects/*', async (req, reply) => {
    const rest = (req.params as Record<string, string>)['*'] ?? '';
    if (rest.split('/').some((seg) => seg === '..')) {
      throw pathTraversal(`路径穿越拒绝: /api/projects/${rest}`);
    }
    return await reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.url} not found`,
        traceId: req.traceId,
      },
    });
  });
};
