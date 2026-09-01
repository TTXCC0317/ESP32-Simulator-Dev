import { create } from 'zustand';
import type {
  EngineEventMap,
  EngineEventType,
  EngineStatus,
  SimulationEngine,
} from '@esp32-sim/shared';
import { useRuntimeStore } from './runtime';

/**
 * simStore（03-§6.2）：仿真状态 + 引擎事件分发。
 * UI 状态走 zustand；引擎实例与订阅表为模块级非响应式状态（不触发渲染）。
 */

/** UI 展示状态（N2 映射）：'building' 仅引擎B编译等待时出现 */
export type SimStatus = EngineStatus | 'building';

export type SimSpeed = 0.25 | 0.5 | 1 | 2 | 4;

type EventHandler = (payload: unknown) => void;

interface SimStore {
  engineKind: 'micropython-wasm' | 'qemu-remote';
  status: SimStatus;
  speed: SimSpeed;
  lastError?: { title: string; detail: string };
  wasmMemBytes: number;
  /** 引擎B 编译进度（build.progress 推送；success/failed 后清空） */
  build: { phase: string; progress: number } | null;

  setEngineKind: (kind: SimStore['engineKind']) => void;
  setStatus: (status: SimStatus, error?: string) => void;
  setSpeed: (speed: SimSpeed) => void;
  setWasmMemBytes: (bytes: number) => void;
  setBuild: (build: { phase: string; progress: number } | null) => void;
  clearError: () => void;
}

/** 模块级引擎运行时状态（单例：工作台同时至多一个仿真会话） */
let engine: SimulationEngine | null = null;
let attachedEngine: SimulationEngine | null = null;
const subscribers = new Map<EngineEventType, Set<EventHandler>>();

function dispatch<K extends EngineEventType>(type: K, payload: EngineEventMap[K]): void {
  const set = subscribers.get(type);
  if (set) for (const cb of set) cb(payload as unknown as unknown);
}

export const useSimStore = create<SimStore>((set) => ({
  engineKind: 'micropython-wasm',
  status: 'idle',
  speed: 1,
  wasmMemBytes: 0,
  build: null,

  setEngineKind: (kind) => set({ engineKind: kind }),
  // 状态变化即刷新错误：有 error → 记录；无 → 清除
  setStatus: (status, error) =>
    set({
      status,
      lastError: error ? { title: '仿真错误', detail: error } : undefined,
      // 编译结束/新会话开始：非 building 状态不保留进度
      ...(status !== 'building' ? { build: null } : {}),
    }),
  setSpeed: (speed) => set({ speed }),
  setWasmMemBytes: (bytes) => set({ wasmMemBytes: bytes }),
  setBuild: (build) => set({ build }),
  clearError: () => set({ lastError: undefined }),
}));

// ---- 引擎会话管理（模块级，供 Worker 客户端 / WS 客户端共用） ----

export const simSession = {
  /** attach 引擎实例并接管其事件流（03-§6.2 attach；幂等防 StrictMode 重复挂载） */
  attach(next: SimulationEngine): void {
    if (attachedEngine === next) return;
    attachedEngine = next;
    engine = next;
    // 新会话：清空上一轮元件运行时状态（gpio.write/pwm.duty/fb.update 汇聚）
    useRuntimeStore.getState().clear();
    // 引擎事件统一转 simStore 分发（组件经 subscribe(type, cb) 消费）；
    // gpio.write/pwm.duty 同步 runtimeStore（元件渲染，M5）；
    // fb.update/neopixel.write 同步 runtimeStore（SSD1306/LED strip 渲染，M9）
    for (const type of [
      'gpio.write',
      'pwm.duty',
      'uart.rx',
      'i2c.txn',
      'spi.txn',
      'fb.update',
      'neopixel.write',
    ] as const) {
      next.on(type, (payload) => {
        if (type === 'gpio.write') {
          const p = payload as EngineEventMap['gpio.write'];
          useRuntimeStore.getState().applyGpio(p.pin, p.level);
        } else if (type === 'pwm.duty') {
          const p = payload as EngineEventMap['pwm.duty'];
          useRuntimeStore.getState().applyPwm(p.pin, p.duty, p.freq);
        } else if (type === 'fb.update') {
          const p = payload as EngineEventMap['fb.update'];
          useRuntimeStore.getState().applyFb(p.partId, p.rect, p.data);
        } else if (type === 'neopixel.write') {
          const p = payload as EngineEventMap['neopixel.write'];
          useRuntimeStore.getState().applyNeopixel(p.partId, p.pixels);
        }
        dispatch(type, payload);
      });
    }
    next.on('log', (payload) => dispatch('log', payload));
    next.on('state', (payload) => {
      useSimStore.getState().setStatus(payload.status, payload.error);
      dispatch('state', payload);
    });
  },

  get engine(): SimulationEngine | null {
    return engine;
  },

  /** 引擎事件订阅（元件渲染 / 串口终端 / 日志面板 / M11 analyzer） */
  subscribe<K extends EngineEventType>(type: K, cb: (p: EngineEventMap[K]) => void): () => void {
    let set = subscribers.get(type);
    if (!set) {
      set = new Set();
      subscribers.set(type, set);
    }
    set.add(cb as EventHandler);
    return () => {
      set?.delete(cb as EventHandler);
      if (set && set.size === 0) subscribers.delete(type);
    };
  },

  /** 停止并释放当前引擎（引擎A：dispose worker；引擎B：ctrl stop） */
  dispose(): void {
    engine?.dispose();
    engine = null;
    attachedEngine = null;
    useRuntimeStore.getState().clear();
    useSimStore.getState().setStatus('idle');
  },
};
