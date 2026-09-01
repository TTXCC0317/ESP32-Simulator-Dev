import { nanoid } from 'nanoid';
import { create } from 'zustand';
import {
  CIRCUIT_LIMITS,
  validateCircuitDoc,
  wireColorSchema,
  type CircuitDoc,
  type Connection,
  type PartId,
  type PartInstance,
  type WireColor,
  type WireSegment,
} from '@esp32-sim/shared';
import { p1ValidationContext } from './catalog-data';
import { nextWireColor, snapPoint, type Vec2 } from './wiring';

/**
 * circuitStore（03-§6.1）：parts/connections 单一数据源。
 * 全部变更经 p1ValidationContext 校验后生效；规模上限见《06-边界说明》§3。
 */

type AttrValue = string | number | boolean;

export interface CircuitStore {
  doc: CircuitDoc;
  dirty: boolean;
  /** 最近一次被拒绝操作的提示（Inspector/Toast 展示） */
  error?: string;
  selectedPartIds: PartId[];
  selectedConnectionId?: string;
  /** I2C_ADDR_CONFLICT / SPI_CS_CONFLICT 涉及的 partId 集合（用于 Canvas 红框渲染） */
  conflictPartIds: Set<string>;

  addPart(type: string, at: Vec2): PartId | null;
  movePart(id: PartId, to: Vec2): void;
  rotatePart(id: PartId): void;
  removePart(id: PartId): void;
  updateAttr(id: PartId, key: string, value: AttrValue): void;
  addConnection(source: string, target: string, path?: WireSegment[]): string | null;
  updateWirePath(id: string, path: WireSegment[]): void;
  setConnectionColor(id: string, color: WireColor): void;
  removeConnection(id: string): void;
  /** JSON 视图导入 / 打开工程；校验失败返回 false 且不改动现有 doc */
  replaceDoc(next: CircuitDoc, opts?: { markClean?: boolean }): boolean;
  selectPart(id?: PartId, additive?: boolean): void;
  selectConnection(id?: string): void;
  clearSelection(): void;
  markSaved(): void;
  /** 仅供测试/开发重置（非业务 action） */
  __reset(): void;
}

export const BOARD_TYPE = 'board-esp32-devkit-c-v4';

/** 新建空白文档：parts[0] 为板卡（03-§2.1 boardType 与 parts[0].type 一致） */
export function createDefaultDoc(boardType: string = BOARD_TYPE, boardId = 'esp'): CircuitDoc {
  return {
    formatVersion: 1,
    boardType,
    parts: [{ id: boardId, type: boardType, left: 60, top: 60, rotate: 0, attrs: {} }],
    connections: [],
    serialMonitor: { baudrate: 115200 },
  };
}

function freshState() {
  return {
    doc: createDefaultDoc(),
    dirty: false,
    error: undefined,
    selectedPartIds: [] as PartId[],
    selectedConnectionId: undefined,
    conflictPartIds: new Set<string>(),
  };
}

/** 从 validateCircuitDoc 提取 I2C/SPI 地址冲突涉及的 partId 集合（M8 Inspector 红框） */
function computeConflictPartIds(doc: CircuitDoc): Set<string> {
  const v = validateCircuitDoc(doc, p1ValidationContext);
  const set = new Set<string>();
  for (const e of v.errors) {
    if (e.code === 'I2C_ADDR_CONFLICT' || e.code === 'SPI_CS_CONFLICT') {
      e.partIds?.forEach((id) => set.add(id));
    }
  }
  return set;
}

export const useCircuitStore = create<CircuitStore>()((set, get) => ({
  ...freshState(),

  addPart(type, at) {
    const { doc } = get();
    if (type.startsWith('board-') && doc.parts.some((p) => p.type.startsWith('board-'))) {
      set({ error: '一个工程只能有一块板卡' });
      return null;
    }
    if (doc.parts.length >= CIRCUIT_LIMITS.maxParts) {
      set({ error: `元件数已达上限 ${CIRCUIT_LIMITS.maxParts}` });
      return null;
    }
    const part: PartInstance = {
      id: `p_${nanoid(6)}`,
      type,
      left: snapPoint(at).x,
      top: snapPoint(at).y,
      rotate: 0,
      attrs: {},
    };
    set({
      doc: { ...doc, parts: [...doc.parts, part] },
      dirty: true,
      error: undefined,
      selectedPartIds: [part.id],
      selectedConnectionId: undefined,
      conflictPartIds: computeConflictPartIds({ ...doc, parts: [...doc.parts, part] }),
    });
    return part.id;
  },

  movePart(id, to) {
    const { doc } = get();
    const p = doc.parts.find((x) => x.id === id);
    if (!p) return;
    const snapped = snapPoint(to);
    set({
      doc: {
        ...doc,
        parts: doc.parts.map((x) => (x.id === id ? { ...x, left: snapped.x, top: snapped.y } : x)),
      },
      dirty: true,
    });
  },

  rotatePart(id) {
    const { doc } = get();
    set({
      doc: {
        ...doc,
        parts: doc.parts.map((x) =>
          x.id === id ? { ...x, rotate: ((x.rotate + 90) % 360) as 0 | 90 | 180 | 270 } : x,
        ),
      },
      dirty: true,
    });
  },

  removePart(id) {
    const { doc } = get();
    const target = doc.parts.find((x) => x.id === id);
    if (!target) return;
    if (target.type.startsWith('board-')) {
      set({ error: '板卡不可删除' });
      return;
    }
    const nextDoc: CircuitDoc = {
      ...doc,
      parts: doc.parts.filter((x) => x.id !== id),
      connections: doc.connections.filter(
        (c) => !c.source.startsWith(`${id}:`) && !c.target.startsWith(`${id}:`),
      ),
    };
    set({
      doc: nextDoc,
      dirty: true,
      selectedPartIds: get().selectedPartIds.filter((x) => x !== id),
      conflictPartIds: computeConflictPartIds(nextDoc),
    });
  },

  updateAttr(id, key, value) {
    const { doc } = get();
    set({
      doc: {
        ...doc,
        parts: doc.parts.map((x) =>
          x.id === id ? { ...x, attrs: { ...x.attrs, [key]: value } } : x,
        ),
      },
      dirty: true,
    });
  },

  addConnection(source, target, path = []) {
    const { doc } = get();
    if (source === target) {
      set({ error: '连线两端不能是同一引脚' });
      return null;
    }
    // 校验前构造临时连接（source/target 尚未验证，合法性由 validateCircuitDoc 兜底）
    const candidate = {
      id: 'tmp',
      source,
      target,
      color: 'green',
      path,
    } as Connection;
    const v = validateCircuitDoc(
      { ...doc, connections: [...doc.connections, candidate] },
      p1ValidationContext,
    );
    const pinErrors = v.errors.filter((e) => e.code === 'BAD_PINREF' || e.code === 'DUP_PART_ID');
    if (pinErrors.length > 0) {
      set({ error: pinErrors[0]?.message ?? '连线校验失败' });
      return null;
    }
    if (doc.connections.length >= CIRCUIT_LIMITS.maxConnections) {
      set({ error: `连线数已达上限 ${CIRCUIT_LIMITS.maxConnections}` });
      return null;
    }
    const id = `w_${nanoid(6)}`;
    const color = nextWireColor(doc.connections.length);
    set({
      doc: {
        ...doc,
        // 候选连接已通过 validateCircuitDoc 校验，PinRef 断言安全
        connections: [
          ...doc.connections,
          {
            id,
            source: source as Connection['source'],
            target: target as Connection['target'],
            color,
            path,
          },
        ],
      },
      dirty: true,
      error: undefined,
      selectedConnectionId: id,
      selectedPartIds: [],
    });
    return id;
  },

  updateWirePath(id, path) {
    const { doc } = get();
    set({
      doc: {
        ...doc,
        connections: doc.connections.map((c) => (c.id === id ? { ...c, path } : c)),
      },
      dirty: true,
    });
  },

  setConnectionColor(id, color) {
    if (!wireColorSchema.safeParse(color).success) {
      set({ error: `未知线色: ${String(color)}` });
      return;
    }
    const { doc } = get();
    set({
      doc: {
        ...doc,
        connections: doc.connections.map((c) => (c.id === id ? { ...c, color } : c)),
      },
      dirty: true,
    });
  },

  removeConnection(id) {
    const { doc } = get();
    set({
      doc: { ...doc, connections: doc.connections.filter((c) => c.id !== id) },
      dirty: true,
      selectedConnectionId:
        get().selectedConnectionId === id ? undefined : get().selectedConnectionId,
    });
  },

  replaceDoc(next, opts) {
    const v = validateCircuitDoc(next, p1ValidationContext);
    if (!v.ok) {
      set({ error: v.errors.map((e) => e.message).join('；') });
      return false;
    }
    set({
      doc: next,
      dirty: opts?.markClean ? false : true,
      error: undefined,
      selectedPartIds: [],
      selectedConnectionId: undefined,
      conflictPartIds: computeConflictPartIds(next),
    });
    return true;
  },

  selectPart(id, additive = false) {
    if (!id) {
      set({ selectedPartIds: [], selectedConnectionId: undefined });
      return;
    }
    if (additive) {
      const cur = get().selectedPartIds;
      set({
        selectedPartIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
        selectedConnectionId: undefined,
      });
    } else {
      set({ selectedPartIds: [id], selectedConnectionId: undefined });
    }
  },

  selectConnection(id) {
    set({ selectedConnectionId: id, selectedPartIds: [] });
  },

  clearSelection() {
    set({ selectedPartIds: [], selectedConnectionId: undefined });
  },

  markSaved() {
    set({ dirty: false });
  },

  __reset() {
    set(freshState());
  },
}));
