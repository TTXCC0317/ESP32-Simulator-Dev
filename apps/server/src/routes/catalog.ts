import type { FastifyPluginAsync } from 'fastify';
import type { ExampleSummary } from '@esp32-sim/shared';
import type { Db } from '../db/client';
import type { CatalogData } from '../services/catalog.service';

/**
 * catalog/examples 只读路由（01-§5.2：GET /api/parts、/api/boards、/api/examples）
 *
 * parts/boards 来自启动期 loadCatalog 的内存缓存（config JSON 为事实源，
 * parts_catalog/board_pinmaps 表供校验与引脚查询，见 03-§6.1）。
 */

export interface CatalogRoutesOptions {
  db: Db;
  catalog: CatalogData;
}

interface ExampleRow {
  id: string;
  name: string;
  category: string;
  manifest_json: string;
}

export const catalogRoutes: FastifyPluginAsync<CatalogRoutesOptions> = async (fastify, opts) => {
  const { db, catalog } = opts;

  fastify.get('/api/parts', async () => {
    return catalog.parts;
  });

  fastify.get('/api/boards', async () => {
    return catalog.boards;
  });

  fastify.get('/api/examples', async (): Promise<ExampleSummary[]> => {
    const rows = db
      .prepare('SELECT id, name, category, manifest_json FROM examples ORDER BY category, id')
      .all() as ExampleRow[];
    return rows.map((r) => {
      const manifest = JSON.parse(r.manifest_json) as {
        description?: string;
        boardType?: string;
        engine?: string;
      };
      return {
        id: r.id,
        name: r.name,
        category: r.category,
        description: manifest.description ?? '',
        // 板卡短名（与 ProjectMeta.boardType 一致；manifest 内为带 board- 前缀的 CircuitDoc 值）
        boardType: (manifest.boardType ?? '').replace(/^board-/, ''),
        engine: manifest.engine ?? '',
      };
    });
  });
};
