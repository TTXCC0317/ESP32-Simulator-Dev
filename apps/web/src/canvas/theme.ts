import type { WireColor } from '@esp32-sim/shared';

/**
 * 画布配色（与双主题 token 协调的固定画布色；04-§11）。
 * Konva 需要具体色值，主题切换仅影响面板/文字（DOM），画布保持工程制图观感。
 */

export const CANVAS_BG = '#0f1115';
export const GRID_LINE = '#20242e';
export const GRID_DOT = '#2b303c';

export const PART_BODY = '#262b36';
export const PART_BODY_LIGHT = '#39404f';
export const PART_STROKE = '#6b7280';
export const TEXT_COLOR = '#e8eaf0';
export const TEXT_DIM = '#9aa3b2';

export const PIN_FILL = '#d1a054';
export const PIN_STROKE = '#8a6420';
export const PIN_HOVER = '#3b82f6';

export const ACCENT = '#3b82f6';
export const SUCCESS = '#22c55e';
export const DANGER = '#ef4444';

/** 选中框/框选/预览统一 accent */
export const SELECTION_COLOR = ACCENT;

export const WIRE_WIDTH = 4;

export const WIRE_HEX: Record<WireColor, string> = {
  green: '#46a758',
  red: '#e5484d',
  orange: '#f5a623',
  yellow: '#eab308',
  blue: '#3b82f6',
  purple: '#b083f0',
  gray: '#8d8d8d',
  black: '#4b5563',
};
