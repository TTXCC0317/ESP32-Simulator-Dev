import { create } from 'zustand';

/**
 * errorsStore（04-§9 错误面板，M6）：统一聚合三类问题源——
 * - build：编译 critical 行（file:line:col 定位，ws-gateway build.progress 推送）
 * - engine：运行时错误（两引擎 state=error / 引擎A traceback 摘要，详见串口）
 * - session：WS 会话错误（error.ack / 断线）
 * 环形 200 条；error 级未读数驱动 BottomPanel 红点角标与自动弹出。
 */

export interface ProblemItem {
  id: number;
  source: 'build' | 'engine' | 'session';
  severity: 'error' | 'warning';
  title: string;
  detail?: string;
  /** 编译错误定位（04-§7.1：file:line:col，Monaco 跳转待排期，先展示） */
  file?: string;
  line?: number;
  col?: number;
  ts: number;
}

const MAX_ITEMS = 200;

let nextId = 1;

interface ErrorsStore {
  items: ProblemItem[];
  unread: number;
  /** 最近一次 error 级 push 的 id（BottomPanel 监听自动弹出；无变化不弹） */
  lastErrorId: number;
  push: (item: Omit<ProblemItem, 'id' | 'ts'> & { ts?: number }) => void;
  markRead: () => void;
  clear: () => void;
}

export const useErrorsStore = create<ErrorsStore>((set) => ({
  items: [],
  unread: 0,
  lastErrorId: 0,

  push: (raw) =>
    set((s) => {
      const item: ProblemItem = { id: nextId++, ts: raw.ts ?? Date.now(), ...raw };
      const items = [...s.items, item];
      if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS);
      return {
        items,
        unread: item.severity === 'error' ? s.unread + 1 : s.unread,
        lastErrorId: item.severity === 'error' ? item.id : s.lastErrorId,
      };
    }),

  markRead: () => set({ unread: 0 }),
  clear: () => set({ items: [], unread: 0 }),
}));
