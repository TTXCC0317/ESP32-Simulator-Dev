import {
  parseDiagram,
  serializeDiagram,
  validateCircuitDoc,
  type CircuitDoc,
  type Connection,
  type PartInstance,
  type WireSegment,
} from '@esp32-sim/shared';
import { p1ValidationContext, P1_CATALOG } from './catalog-data';

/**
 * diagram.json 双向同步（02-M2：画布⇄JSON 文本视图）+ Wokwi 工程导入。
 *
 * Wokwi diagram.json 与本项目 CircuitDoc 的差异：
 * - 顶层额外字段（version/author/editor…）→ 忽略；
 * - parts 可省略 rotate → 补 0；
 * - connections 是 [source, target, color, path[]] 数组 → 转 Connection 对象；
 * - path 是 "v0"/"h30"/"*" 字符串数组 → 转 WireSegment；
 * - 未收录 type → 跳过并计入 skipped（连同其连线）。
 */

export interface ImportDiagramResult {
  doc?: CircuitDoc;
  /** 未收录而被跳过的元件类型（验收要求的"跳过清单"） */
  skipped: string[];
  errors: string[];
}

function parseWokwiPathToken(token: string): WireSegment | null {
  const m = /^\s*([vh*])\s*(-?\d+(?:\.\d+)?)?\s*$/i.exec(token);
  const dir = m?.[1]?.toLowerCase();
  if (!dir) return null;
  const len = m?.[2] ? Math.round(Number(m[2])) : 0;
  return { dir: dir as 'v' | 'h' | '*', len };
}

/** 宽松输入 → CircuitDoc（兼容本项目导出与 Wokwi blink 等简单工程） */
export function importDiagram(raw: unknown): ImportDiagramResult {
  const errors: string[] = [];
  const skipped: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { skipped, errors: ['diagram 根节点不是对象'] };
  }
  const obj = raw as Record<string, unknown>;
  const rawParts = Array.isArray(obj['parts']) ? obj['parts'] : [];
  const rawConns = Array.isArray(obj['connections']) ? obj['connections'] : [];

  const parts: PartInstance[] = [];
  const keptIds = new Set<string>();
  for (const [i, rp] of rawParts.entries()) {
    if (typeof rp !== 'object' || rp === null) {
      errors.push(`parts[${i}] 不是对象`);
      continue;
    }
    const p = rp as Record<string, unknown>;
    const type = String(p['type'] ?? '');
    const id = String(p['id'] ?? `p_${i}`);
    if (!P1_CATALOG.has(type)) {
      if (!skipped.includes(type)) skipped.push(type);
      continue;
    }
    keptIds.add(id);
    parts.push({
      id,
      type,
      left: Number(p['left'] ?? 0) || 0,
      top: Number(p['top'] ?? 0) || 0,
      rotate: (p['rotate'] === 90 || p['rotate'] === 180 || p['rotate'] === 270
        ? p['rotate']
        : 0) as 0 | 90 | 180 | 270,
      attrs: (typeof p['attrs'] === 'object' && p['attrs'] !== null ? p['attrs'] : {}) as Record<
        string,
        string | number | boolean
      >,
    });
  }

  const boardPart = parts.find((p) => p.type.startsWith('board-'));
  const connections: Connection[] = [];
  for (const [i, rc] of rawConns.entries()) {
    let source: string;
    let target: string;
    let color = 'green';
    let path: WireSegment[] = [];
    if (Array.isArray(rc)) {
      const [s, t, c, pth] = rc as [unknown, unknown, unknown, unknown];
      source = String(s ?? '');
      target = String(t ?? '');
      if (typeof c === 'string') color = c;
      if (Array.isArray(pth)) {
        path = pth
          .map((tok) => (typeof tok === 'string' ? parseWokwiPathToken(tok) : null))
          .filter((x): x is WireSegment => x !== null && x.dir !== '*');
      }
    } else if (typeof rc === 'object' && rc !== null) {
      const c = rc as Record<string, unknown>;
      source = String(c['source'] ?? '');
      target = String(c['target'] ?? '');
      if (typeof c['color'] === 'string') color = c['color'];
      if (Array.isArray(c['path'])) path = c['path'] as WireSegment[];
    } else {
      errors.push(`connections[${i}] 格式非法`);
      continue;
    }
    const [srcPart] = source.split(':');
    const [dstPart] = target.split(':');
    if (!srcPart || !dstPart || !keptIds.has(srcPart) || !keptIds.has(dstPart)) continue; // 跳过挂接在未收录元件上的连线
    connections.push({
      id: `w_${i}`,
      // 宽松导入：合法性由调用方 validateCircuitDoc 兜底（非法 PinRef 会被拒绝应用）
      source: source as Connection['source'],
      target: target as Connection['target'],
      color: color as Connection['color'],
      path,
    });
  }

  const doc: CircuitDoc = {
    formatVersion: 1,
    boardType: boardPart?.type ?? 'board-esp32-devkit-c-v4',
    parts,
    connections,
    serialMonitor: { baudrate: 115200 },
  };
  return { doc, skipped, errors };
}

/** 应用 diagram 文本到画布：parse → import 语义规范化 → validate → 返回可替换文档 */
export function applyDiagramText(
  text: string,
): { ok: true; doc: CircuitDoc; skipped: string[] } | { ok: false; errors: string[] } {
  const parsed = parseDiagram(text);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.validation.errors.map((e) => e.message) };
  }
  const imported = importDiagram(parsed.doc);
  if (imported.errors.length > 0 || !imported.doc) {
    return { ok: false, errors: imported.errors };
  }
  const v = validateCircuitDoc(imported.doc, p1ValidationContext);
  if (!v.ok) {
    return { ok: false, errors: v.errors.map((e) => e.message) };
  }
  return { ok: true, doc: imported.doc, skipped: imported.skipped };
}

/** 画布当前文档 → diagram 文本 */
export function buildDiagramText(doc: CircuitDoc): string {
  return serializeDiagram(doc);
}

/** Wokwi 官方 blink 示例（验收：导入可渲染） */
export const WOKWI_BLINK_SAMPLE = JSON.stringify(
  {
    version: 1,
    author: 'wokwi',
    editor: 'wokwi',
    parts: [
      { type: 'board-esp32-devkit-c-v4', id: 'esp', top: 0, left: 0, attrs: {} },
      {
        type: 'wokwi-led',
        id: 'led1',
        top: -80,
        left: 280,
        attrs: { color: 'red' },
      },
      {
        type: 'wokwi-resistor',
        id: 'r1',
        top: -40,
        left: 240,
        rotate: 90,
        attrs: { value: '1000' },
      },
    ],
    connections: [
      ['esp:GPIO4', 'r1:1', 'green', ['v0']],
      ['r1:2', 'led1:A', 'green', ['v0']],
      ['led1:C', 'esp:GND.1', 'black', ['v0']],
    ],
  },
  null,
  2,
);
