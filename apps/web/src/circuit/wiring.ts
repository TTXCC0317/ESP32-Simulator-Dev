import type { PartInstance, WireColor, WireSegment } from '@esp32-sim/shared';
import { P1_CATALOG } from './catalog-data';

/**
 * 连线几何（《03-核心模块详细设计》§5.2 WiringTool、
 * 《04-UI详细设计》§6.3、Wokwi `v/h/*` 路径语义）
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const GRID = 20;

/** 8 色轮转（Wokwi 惯例：绿→红→橙→黄→蓝→紫→灰→黑） */
export const WIRE_COLOR_CYCLE: readonly WireColor[] = [
  'green',
  'red',
  'orange',
  'yellow',
  'blue',
  'purple',
  'gray',
  'black',
];

export const WIRE_COLOR_HEX: Readonly<Record<WireColor, string>> = {
  green: '#46a758',
  red: '#e5484d',
  orange: '#f5a623',
  yellow: '#eab308',
  blue: '#3b82f6',
  purple: '#b083f0',
  gray: '#8d8d8d',
  black: '#2a2e37',
};

export function nextWireColor(index: number): WireColor {
  const cycle = WIRE_COLOR_CYCLE.length;
  return WIRE_COLOR_CYCLE[((index % cycle) + cycle) % cycle] ?? 'green';
}

export function snapToGrid(v: number): number {
  return Math.round(v / GRID) * GRID;
}

export function snapPoint(p: Vec2): Vec2 {
  return { x: snapToGrid(p.x), y: snapToGrid(p.y) };
}

/**
 * 引脚世界坐标（旋转感知）：pin (x,y) 相对元件左上角，旋转围绕封装中心。
 * 旋转与 Konva Group（offset=中心，rotation=CW 度数）渲染一致。
 */
export function pinWorldPos(part: PartInstance, pinName: string): Vec2 | null {
  const def = P1_CATALOG.get(part.type);
  if (!def) return null;
  const pin = def.pins.find((p) => p.name === pinName);
  if (!pin) return null;
  const { width: w, height: h } = def.renderer;
  const cx = part.left + w / 2;
  const cy = part.top + h / 2;
  const ox = pin.x - w / 2;
  const oy = pin.y - h / 2;
  switch (part.rotate) {
    case 90:
      return { x: cx - oy, y: cy + ox };
    case 180:
      return { x: cx - ox, y: cy - oy };
    case 270:
      return { x: cx + oy, y: cy - ox };
    default:
      return { x: cx + ox, y: cy + oy };
  }
}

/** 自动正交布线：先垂直后水平（04-§6.3），零长段省略 */
export function autoSegments(from: Vec2, to: Vec2): WireSegment[] {
  const segs: WireSegment[] = [];
  if (to.y !== from.y) segs.push({ dir: 'v', len: to.y - from.y });
  if (to.x !== from.x) segs.push({ dir: 'h', len: to.x - from.x });
  return segs;
}

/** 路径 → 折线顶点（含起点；零长段产生重复顶点，渲染时过滤） */
export function pathToPoints(from: Vec2, path: WireSegment[]): Vec2[] {
  const pts: Vec2[] = [{ ...from }];
  let x = from.x;
  let y = from.y;
  for (const seg of path) {
    if (seg.dir === 'v') y += seg.len;
    else if (seg.dir === 'h') x += seg.len;
    pts.push({ x, y });
  }
  return pts;
}

/**
 * 完整连线解析：
 * - path 为空 → 自动 v-then-h；
 * - 含 '*' 段 → 从该处起自动接续到终点（其后段忽略）；
 * - 走完仍不落在终点 → 强制补终边（兜底，不产生悬空线）。
 */
export function resolveWirePoints(from: Vec2, to: Vec2, path: WireSegment[]): Vec2[] {
  const dedupe = (pts: Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
    }
    return out;
  };

  if (path.length === 0) return dedupe(pathToPoints(from, autoSegments(from, to)));

  const starIdx = path.findIndex((s) => s.dir === '*');
  if (starIdx >= 0) {
    const pts = pathToPoints(from, path.slice(0, starIdx));
    const cur = pts[pts.length - 1];
    if (!cur) return [{ ...from }];
    return dedupe([...pts.slice(0, -1), ...pathToPoints(cur, autoSegments(cur, to))]);
  }

  const pts = pathToPoints(from, path);
  const last = pts[pts.length - 1] ?? to;
  if (last.x !== to.x || last.y !== to.y) {
    return dedupe([...pts.slice(0, -1), ...pathToPoints(last, autoSegments(last, to))]);
  }
  return dedupe(pts);
}

// ---- 锚点（段）编辑（04-§5 连线选中态：锚点列表 上移/下移/删除 + 长度调整） ----

export function setSegmentLen(path: WireSegment[], index: number, len: number): WireSegment[] {
  return path.map((s, i) => (i === index ? { ...s, len } : s));
}

/** 上移/下移：与相邻段交换顺序（delta -1 / +1），越界返回原数组 */
export function moveSegment(path: WireSegment[], index: number, delta: number): WireSegment[] {
  const j = index + delta;
  const cur = path[index];
  const neighbor = path[j];
  if (!cur || !neighbor) return path;
  const next = [...path];
  next[index] = neighbor;
  next[j] = cur;
  return next;
}

export function removeSegment(path: WireSegment[], index: number): WireSegment[] {
  return path.filter((_, i) => i !== index);
}
