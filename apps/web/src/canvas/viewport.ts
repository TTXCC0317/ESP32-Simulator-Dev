import type { Vec2 } from '../circuit/wiring';

/** 视图变换（04-§6.2：滚轮以指针为中心 0.25–4x，步进 10%；Ctrl+0 复位 / Ctrl+1 适应窗口） */

export interface Viewport {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** 以屏幕点 pointer 为中心缩放 factor 倍 */
export function zoomAt(vp: Viewport, pointer: Vec2, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor);
  const k = scale / vp.scale;
  return {
    scale,
    x: pointer.x - (pointer.x - vp.x) * k,
    y: pointer.y - (pointer.y - vp.y) * k,
  };
}

/** 屏幕 → 世界坐标 */
export function toWorld(vp: Viewport, p: Vec2): Vec2 {
  return { x: (p.x - vp.x) / vp.scale, y: (p.y - vp.y) / vp.scale };
}

/** 复位 100%（保持视口中心的世界点不动） */
export function resetZoom(vp: Viewport, center: Vec2): Viewport {
  const worldCenter = toWorld(vp, center);
  return {
    scale: 1,
    x: center.x - worldCenter.x,
    y: center.y - worldCenter.y,
  };
}

/** 适应窗口：bbox(世界坐标) 填充容器（含 40px padding） */
export function fitContent(
  bbox: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
): Viewport {
  const pad = 40;
  const scale = clampScale(
    Math.min(size.width / (bbox.width + pad * 2), size.height / (bbox.height + pad * 2), 2),
  );
  return {
    scale,
    x: size.width / 2 - (bbox.x + bbox.width / 2) * scale,
    y: size.height / 2 - (bbox.y + bbox.height / 2) * scale,
  };
}
