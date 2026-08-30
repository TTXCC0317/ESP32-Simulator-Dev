import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * UI 全局状态（04-§2/§3/§11）
 *
 * - theme：'dark' 默认；切换经 applyTheme() 即时写 html[data-theme]（无组件重挂载）；
 * - 面板尺寸/折叠按 04-§2 持久化（M1 存 localStorage，M3 迁 settings 表 key='ui.layout'）；
 * - BottomPanel 高度可拖 180–480px（04-§2）。
 */

export type Theme = 'dark' | 'light';

export interface UiState {
  theme: Theme;
  locale: 'zh-CN' | 'en-US';
  libraryCollapsed: boolean;
  inspectorCollapsed: boolean;
  bottomCollapsed: boolean;
  bottomHeight: number;
  /** 蜂鸣器静音（05-§1.8 E4）：true 时跳过 OscillatorNode.start（视觉照常） */
  muted: boolean;
  /** 画布截图钩子（04-§8 D3）：保存工程前由 CircuitCanvas 注册，生成 240×160 PNG dataURL */
  stageCapture: (() => string | null) | null;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setLocale: (l: 'zh-CN' | 'en-US') => void;
  toggleLibrary: () => void;
  toggleInspector: () => void;
  toggleBottom: () => void;
  setBottomHeight: (h: number) => void;
  toggleMuted: () => void;
  setStageCapture: (fn: (() => string | null) | null) => void;
}

/** 写根节点 data-theme（index.html 内联脚本同规则，保证刷新前一致） */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

const BOTTOM_MIN = 180;
const BOTTOM_MAX = 480;
const BOTTOM_DEFAULT = 260;

export const clampBottomHeight = (h: number): number =>
  Math.min(BOTTOM_MAX, Math.max(BOTTOM_MIN, Math.round(h)));

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'dark',
      locale: 'zh-CN',
      libraryCollapsed: false,
      inspectorCollapsed: false,
      bottomCollapsed: false,
      bottomHeight: BOTTOM_DEFAULT,
      muted: false,
      stageCapture: null,
      setTheme: (t) => {
        applyTheme(t);
        set({ theme: t });
      },
      toggleTheme: () =>
        set((s) => {
          const t: Theme = s.theme === 'dark' ? 'light' : 'dark';
          applyTheme(t);
          return { theme: t };
        }),
      setLocale: (locale) => set({ locale }),
      toggleLibrary: () => set((s) => ({ libraryCollapsed: !s.libraryCollapsed })),
      toggleInspector: () => set((s) => ({ inspectorCollapsed: !s.inspectorCollapsed })),
      toggleBottom: () => set((s) => ({ bottomCollapsed: !s.bottomCollapsed })),
      setBottomHeight: (h) => set({ bottomHeight: clampBottomHeight(h) }),
      toggleMuted: () => set((s) => ({ muted: !s.muted })),
      setStageCapture: (fn) => set({ stageCapture: fn }),
    }),
    {
      name: 'esp32-sim.ui',
      // theme 持久化；applyTheme 在 index.html 内联脚本 + main.tsx 启动时兜底
      partialize: (s) => ({
        theme: s.theme,
        locale: s.locale,
        libraryCollapsed: s.libraryCollapsed,
        inspectorCollapsed: s.inspectorCollapsed,
        bottomCollapsed: s.bottomCollapsed,
        bottomHeight: s.bottomHeight,
        muted: s.muted,
      }),
    },
  ),
);
