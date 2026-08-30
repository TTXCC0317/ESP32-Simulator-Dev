import { create } from 'zustand';
import type { CreateProjectInput, ExampleSummary, ProjectMeta } from '@esp32-sim/shared';
import { ApiError, api } from '../api/client';
import { useCircuitStore } from '../circuit/circuitStore';
import { pushSnapshot } from '../circuit/snapshots';
import { useUiStore } from './ui';

/**
 * 工程列表/当前工程状态（04-§8 + 保存流程）：
 * - 列表页：refresh/create/duplicate/remove/import；
 * - 工作台：loadCurrent 打开工程（diagram 注入 circuitStore）、saveCurrent（PUT + 缩略图）。
 */

export interface ProjectStore {
  projects: ProjectMeta[];
  examples: ExampleSummary[];
  loading: boolean;
  error: string | null;
  /** 工作台当前工程（元数据；diagram 在 circuitStore.doc） */
  current: ProjectMeta | null;
  saving: boolean;
  savedAt: number | null;

  refresh(): Promise<void>;
  clearError(): void;
  create(input: CreateProjectInput): Promise<ProjectMeta>;
  duplicate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  importBundle(bundle: unknown): Promise<ProjectMeta>;
  loadCurrent(id: string): Promise<boolean>;
  renameCurrent(name: string): void;
  saveCurrent(): Promise<boolean>;
  leaveCurrent(): void;
}

function toMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export const useProjectStore = create<ProjectStore>()((set, get) => ({
  projects: [],
  examples: [],
  loading: false,
  error: null,
  current: null,
  saving: false,
  savedAt: null,

  async refresh() {
    set({ loading: true, error: null });
    try {
      const [projects, examples] = await Promise.all([api.listProjects(), api.listExamples()]);
      set({ projects, examples, loading: false });
    } catch (err) {
      set({ loading: false, error: toMessage(err) });
    }
  },

  clearError() {
    set({ error: null });
  },

  async create(input) {
    const meta = await api.createProject(input);
    set((s) => ({ projects: [meta, ...s.projects] }));
    return meta;
  },

  async duplicate(id) {
    try {
      const meta = await api.copyProject(id);
      set((s) => ({ projects: [meta, ...s.projects] }));
    } catch (err) {
      set({ error: toMessage(err) });
    }
  },

  async remove(id) {
    try {
      await api.deleteProject(id);
      set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
    } catch (err) {
      set({ error: toMessage(err) });
    }
  },

  async importBundle(bundle) {
    const meta = await api.importProject(bundle);
    set((s) => ({ projects: [meta, ...s.projects] }));
    return meta;
  },

  async loadCurrent(id) {
    try {
      const detail = await api.getProject(id);
      const ok = useCircuitStore.getState().replaceDoc(detail.diagram, { markClean: true });
      if (!ok) {
        set({ error: `工程 diagram 校验失败：${useCircuitStore.getState().error ?? ''}` });
        return false;
      }
      set({
        current: {
          id: detail.id,
          name: detail.name,
          description: detail.description,
          boardType: detail.boardType,
          engine: detail.engine,
          thumbnail: detail.thumbnail,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
        },
        savedAt: null,
        error: null,
      });
      return true;
    } catch (err) {
      set({ error: toMessage(err) });
      return false;
    }
  },

  renameCurrent(name) {
    set((s) => (s.current ? { current: { ...s.current, name } } : {}));
  },

  async saveCurrent() {
    const cur = get().current;
    if (!cur || get().saving) return false;
    const doc = useCircuitStore.getState().doc;
    const capture = useUiStore.getState().stageCapture;
    // 缩略图在保存前同步生成（04-§8 D3：不展示 Overlay 高亮的内存画布截图）
    const thumbnail = capture ? capture() : null;
    set({ saving: true, error: null });
    try {
      const meta = await api.updateProject(cur.id, {
        name: cur.name,
        diagram: doc,
        thumbnail,
      });
      useCircuitStore.getState().markSaved();
      set({ current: meta, saving: false, savedAt: Date.now() });
      // 画布自动快照（06-§7.2 F2）：保存成功后写入 IndexedDB 环形 5 槽（尽力而为）
      void pushSnapshot(cur.id, doc);
      return true;
    } catch (err) {
      set({ saving: false, error: toMessage(err) });
      return false;
    }
  },

  leaveCurrent() {
    set({ current: null, savedAt: null, error: null });
  },
}));
