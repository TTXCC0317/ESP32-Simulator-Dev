import { create } from 'zustand';

/**
 * 元件库 → 画布拖拽（04-§4 D1：react-konva 不支持 HTML5 DnD，统一指针事件模拟；
 * 跟随光标的半透明预览用 position:fixed DOM 元素，不走 Konva）
 */

export interface DragState {
  type: string;
  sx: number;
  sy: number;
}

interface DndStore {
  drag: DragState | null;
  start(type: string, sx: number, sy: number): void;
  move(sx: number, sy: number): void;
  end(): { type: string; sx: number; sy: number } | null;
}

export const useDndStore = create<DndStore>()((set, get) => ({
  drag: null,
  start(type, sx, sy) {
    set({ drag: { type, sx, sy } });
  },
  move(sx, sy) {
    const d = get().drag;
    if (d) set({ drag: { ...d, sx, sy } });
  },
  end() {
    const d = get().drag;
    set({ drag: null });
    return d;
  },
}));
