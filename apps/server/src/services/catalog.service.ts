import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  boardDefinitionSchema,
  partDefinitionSchema,
  type BoardDefinition,
  type PartDefinition,
  type ValidationContext,
} from '@esp32-sim/shared';
import type { Db } from '../db/client';

/**
 * catalog.service（02-§4 M3）：启动读取 config/parts/*.json 与 config/boards/*.json，
 * zod 校验后导入 parts_catalog / board_pinmaps（01-§6：只读缓存表，便于统一查询）。
 * 配置错误 fail-fast（抛异常 → 启动失败），避免带病运行。
 */

export interface CatalogData {
  parts: PartDefinition[];
  boards: BoardDefinition[];
}

export function loadCatalog(configDir: string): CatalogData {
  const partsDir = join(configDir, 'parts');
  const boardsDir = join(configDir, 'boards');

  const parts = readdirSync(partsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => partDefinitionSchema.parse(JSON.parse(readFileSync(join(partsDir, f), 'utf8'))));

  const boards = readdirSync(boardsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => boardDefinitionSchema.parse(JSON.parse(readFileSync(join(boardsDir, f), 'utf8'))));

  return { parts, boards };
}

/** 导入 parts_catalog + board_pinmaps（幂等：INSERT OR REPLACE）；单个 transaction */
export function importCatalog(db: Db, catalog: CatalogData): void {
  const insPart = db.prepare(
    'INSERT OR REPLACE INTO parts_catalog (type, name, category, definition_json) VALUES (?, ?, ?, ?)',
  );
  const insPin = db.prepare(
    'INSERT OR REPLACE INTO board_pinmaps (board_type, pin_name, gpio_no, capabilities, x, y, col) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  db.transaction(() => {
    for (const p of catalog.parts) {
      insPart.run(p.type, p.name, p.category, JSON.stringify(p));
    }
    for (const b of catalog.boards) {
      for (const pin of b.pins) {
        insPin.run(b.type, pin.name, pin.gpio, JSON.stringify(pin.caps), pin.x, pin.y, pin.col);
      }
    }
  })();
}

/** 由 catalog 构建 validateCircuitDoc 的 ValidationContext（03-§6.1 服务端侧） */
export function buildValidationContext(catalog: CatalogData): ValidationContext {
  const map = new Map(catalog.parts.map((d) => [d.type, d]));
  return {
    partTypes: new Set(map.keys()),
    pinNames: (type: string) => {
      const def = map.get(type);
      return def ? new Set(def.pins.map((p) => p.name)) : undefined;
    },
    deviceSpec: (type: string) => {
      const def = map.get(type);
      return def?.simulator?.device ?? null;
    },
  };
}
