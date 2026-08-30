import type {
  CircuitDoc,
  EngineEvent,
  EngineEventMap,
  EngineEventType,
  FirmwareInput,
  InputEvent,
  SimulationEngine,
} from '@esp32-sim/shared';
import type { WorkerMsg, WorkerReply } from '@esp32-sim/shared';
import { useErrorsStore } from '../../stores/errors';
import { useSimStore } from '../../stores/sim';

/**
 * EngineWorkerClient（03-§3.5 主线程消费侧）：
 * SimulationEngine 接口 → Worker postMessage 转发；event.batch 经 rAF 二次合并
 * （worker 16ms batch + 主线程一帧 flush，避免每个 gpio.write 触发 Konva 重绘）。
 * 事件经 simSession 语义分发：由调用方 simSession.attach(this) 订阅。
 * 错误面板（04-§9，M6）：state error / log error（stderr traceback、执行中断）→ errorsStore。
 */

type Handler<K extends EngineEventType> = (payload: EngineEventMap[K]) => void;

/** 引擎A 单会话 WASM 内存上限（06-§4 浏览器内存边界：256MB 超限提示并停止） */
const MAX_WASM_MEM_BYTES = 256 * 1024 * 1024;

export class EngineWorkerClient implements SimulationEngine {
  readonly kind = 'micropython-wasm' as const;

  private worker: Worker;
  private handlers = new Map<EngineEventType, Set<Handler<EngineEventType>>>();
  private pendingEvents: EngineEvent[] = [];
  private rafId = 0;
  private readyPromise: Promise<number> | null = null;
  private readyResolve: ((bytes: number) => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private lastLoad: { circuit: CircuitDoc; fw: FirmwareInput } | null = null;

  constructor() {
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => this.onReply(e.data);
    this.worker.onerror = (e) => {
      useErrorsStore.getState().push({
        source: 'engine',
        severity: 'error',
        title: '引擎A Worker 错误',
        detail: e.message,
      });
      this.readyReject?.(new Error(`Worker 加载失败：${e.message}`));
      useSimStore.getState().setStatus('error', `Worker 加载失败：${e.message}`);
    };
  }

  private onReply(msg: WorkerReply): void {
    switch (msg.type) {
      case 'event.batch':
        this.pendingEvents.push(...msg.payload.events);
        if (!this.rafId) this.rafId = requestAnimationFrame(this.flush);
        break;
      case 'state':
        useSimStore.getState().setStatus(msg.payload.status, msg.payload.error);
        if (msg.payload.status === 'error') {
          useErrorsStore.getState().push({
            source: 'engine',
            severity: 'error',
            title: '引擎A 错误',
            ...(msg.payload.error ? { detail: msg.payload.error } : {}),
          });
        }
        break;
      case 'log':
        // stderr traceback / 执行中断等错误行聚合到问题面板（04-§9）
        if (msg.payload.level === 'error') {
          useErrorsStore.getState().push({
            source: 'engine',
            severity: 'error',
            title: '引擎A 运行错误',
            detail: msg.payload.text,
          });
        }
        this.emit('log', msg.payload);
        break;
      case 'ready': {
        useSimStore.getState().setWasmMemBytes(msg.payload.wasmMemBytes);
        if (msg.payload.wasmMemBytes > MAX_WASM_MEM_BYTES) {
          const msg2 = `WASM 内存 ${Math.round(msg.payload.wasmMemBytes / 1024 / 1024)}MB 超过 256MB 上限，已停止`;
          useErrorsStore.getState().push({
            source: 'engine',
            severity: 'error',
            title: '引擎A 内存超限',
            detail: msg2,
          });
          useSimStore.getState().setStatus('error', msg2);
        }
        this.readyResolve?.(msg.payload.wasmMemBytes);
        break;
      }
    }
  }

  private flush = (): void => {
    this.rafId = 0;
    const events = this.pendingEvents.splice(0);
    for (const ev of events) this.emit(ev.kind, ev);
  };

  private emit<K extends EngineEventType>(type: K, payload: EngineEventMap[K]): void {
    const set = this.handlers.get(type);
    if (set) for (const cb of set) cb(payload);
  }

  on<K extends EngineEventType>(type: K, cb: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(cb as Handler<EngineEventType>);
    return () => {
      set?.delete(cb as Handler<EngineEventType>);
      if (set && set.size === 0) this.handlers.delete(type);
    };
  }

  async load(circuit: CircuitDoc, fw: FirmwareInput): Promise<void> {
    if (fw.kind !== 'sources') throw new Error('引擎A 仅接受源码输入（sources）');
    this.lastLoad = { circuit, fw };
    this.readyPromise = new Promise<number>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // load 前 60s 超时保护（wasm 加载/执行卡死兜底，06-§4 会话超时）
    const timeout = setTimeout(() => this.readyReject?.(new Error('引擎装载超时（60s）')), 60_000);
    this.post({ type: 'load', payload: { circuit, fw } });
    try {
      await this.readyPromise;
    } finally {
      clearTimeout(timeout);
      this.readyPromise = null;
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  start(opts?: { speed?: 0.25 | 0.5 | 1 | 2 | 4 }): void {
    this.post({ type: 'start', payload: opts ?? {} });
  }

  pause(): void {
    this.post({ type: 'pause' });
  }

  reset(): void {
    if (!this.lastLoad) return;
    // Worker 内 engine.reset() 重建 wasm 实例（干净全局状态，含 PinBus/token 重置）
    this.post({ type: 'reset' });
  }

  input(ev: InputEvent): void {
    this.post({ type: 'input', payload: ev });
  }

  dispose(): void {
    this.post({ type: 'dispose' });
    this.worker.terminate();
    this.handlers.clear();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private post(m: WorkerMsg): void {
    this.worker.postMessage(m);
  }
}
