import type {
  CircuitDoc,
  EngineEventMap,
  EngineEventType,
  FirmwareInput,
  InputEvent,
  SimulationEngine,
} from '@esp32-sim/shared';
import { serverMsgSchema } from '@esp32-sim/shared';
import { api } from '../../api/client';
import { useProjectStore } from '../../stores/project';
import { useSimStore, type SimStatus } from '../../stores/sim';

/**
 * RemoteSessionClient（03-§6.3 + §7.3/§7.4 引擎B 前端消费侧）：
 * SimulationEngine 接口 → 引擎B WS 会话（/ws/sim/:sid）。
 * load：POST /api/build → WS attach → build.progress 推送 → state running 时 resolve；
 * N2 映射：attaching→loading、building-wait→building、closed→idle；
 * 串口/输入：uart.tx → input.uart；pin.level/analog.value → input.pin/input.analog（M5 GPIO 桥消费）。
 */

type Handler<K extends EngineEventType> = (payload: EngineEventMap[K]) => void;

const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

/** N2 状态映射：ServerMsg.state → simStore.status（engine.ts §N2 表） */
const STATE_TO_STATUS: Record<string, SimStatus> = {
  attaching: 'loading',
  'building-wait': 'building',
  running: 'running',
  paused: 'paused',
  error: 'error',
  closed: 'idle',
};

export class RemoteSessionClient implements SimulationEngine {
  readonly kind = 'qemu-remote' as const;

  private ws: WebSocket | null = null;
  private sid: string;
  private closedByUs = false;
  private handlers = new Map<EngineEventType, Set<Handler<EngineEventType>>>();
  private loadResolve: (() => void) | null = null;
  private loadReject: ((err: Error) => void) | null = null;

  constructor() {
    this.sid = `s-${crypto.randomUUID().slice(0, 8)}`;
  }

  async load(circuit: CircuitDoc, fw: FirmwareInput): Promise<void> {
    if (fw.kind !== 'sources') throw new Error('引擎B 前端仅提交源码（固件由服务端编译）');
    const projectId = useProjectStore.getState().current?.id;
    if (!projectId) throw new Error('未打开工程');

    // 1) 提交编译（202 + buildId；排队/执行由 BuildService 队列控制）
    const { buildId } = await api.submitBuild({ projectId, toolchain: 'arduino' });

    // 2) WS 会话 + attach（onopen 内发送）
    await this.connect(buildId, circuit, projectId);

    // 3) 等 state running（编译 success → QEMU spawn 后到达）
    return new Promise<void>((resolve, reject) => {
      this.loadResolve = resolve;
      this.loadReject = reject;
    });
  }

  private connect(buildId: string, circuit: CircuitDoc, projectId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const fail = (err: Error): void => {
        useSimStore.getState().setStatus('error', err.message);
        reject(err);
        // load 阶段断线：同步终止 load 等待（running 后 reject 已 settled，无副作用）
        this.loadReject?.(err);
        this.loadResolve = null;
        this.loadReject = null;
      };
      const ws = new WebSocket(`${WS_BASE}/ws/sim/${this.sid}`);
      this.ws = ws;
      ws.onopen = () => {
        this.send({
          type: 'attach',
          payload: { projectId, circuit, firmwareId: buildId, boardType: circuit.boardType },
        });
        resolve();
      };
      ws.onmessage = (e) => this.onMessage(e.data as string);
      ws.onclose = () => {
        this.ws = null;
        if (this.closedByUs) return;
        // 编译等待中断线：60s 重连窗口内重新运行可复用编译产物（06-§4）
        fail(new Error('引擎B 会话连接断开（重新运行可复用编译产物）'));
      };
      ws.onerror = () => {
        // onclose 随后触发，错误统一在 onclose 上报
      };
    });
  }

  private onMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = serverMsgSchema.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;

    switch (msg.type) {
      case 'state': {
        const st = STATE_TO_STATUS[msg.payload.status] ?? 'error';
        useSimStore.getState().setStatus(st, msg.payload.error);
        // 'building' 是 UI 层扩展（EngineStatus 无此值）：事件侧按 loading 语义发布
        this.emit('state', {
          status: st === 'building' ? 'loading' : st,
          error: msg.payload.error,
        });
        if (msg.payload.status === 'running') {
          this.loadResolve?.();
        } else if (msg.payload.status === 'error') {
          this.loadReject?.(new Error(msg.payload.error ?? '引擎B 会话错误'));
        }
        if (msg.payload.status === 'running' || msg.payload.status === 'error') {
          this.loadResolve = null;
          this.loadReject = null;
        }
        break;
      }
      case 'uart.rx':
        this.emit('uart.rx', { bytes: new Uint8Array(msg.payload.bytes), port: 0 });
        break;
      case 'gpio.write':
        this.emit('gpio.write', msg.payload);
        break;
      case 'pwm.duty':
        this.emit('pwm.duty', msg.payload);
        break;
      case 'i2c.txn':
        this.emit('i2c.txn', { ...msg.payload, data: new Uint8Array(msg.payload.data) });
        break;
      case 'spi.txn':
        this.emit('spi.txn', { ...msg.payload, data: new Uint8Array(msg.payload.data) });
        break;
      case 'fb.update':
        this.emit('fb.update', { ...msg.payload, data: new Uint8Array(msg.payload.data) });
        break;
      case 'log':
        this.emit('log', msg.payload);
        break;
      case 'build.progress': {
        useSimStore.getState().setBuild({
          phase: msg.payload.phase,
          progress: msg.payload.progress,
        });
        if (msg.payload.logLine !== undefined) {
          // critical 行（error/warning）→ warn 级日志
          this.emit('log', { level: 'warn', text: msg.payload.logLine });
        }
        if (msg.payload.logLines) {
          for (const line of msg.payload.logLines) {
            this.emit('log', { level: 'info', text: line });
          }
        }
        if (msg.payload.phase === 'failed') {
          this.loadReject?.(new Error(msg.payload.error ?? '编译失败'));
          this.loadResolve = null;
          this.loadReject = null;
        }
        break;
      }
      case 'error.ack':
        this.emit('log', { level: 'error', text: `[${msg.payload.code}] ${msg.payload.message}` });
        break;
    }
  }

  start(): void {
    // attach 后服务端自动 running；start 仅用于 ctrl 复位（M4 无暂停语义）
    this.send({ type: 'ctrl', payload: 'start' });
  }

  pause(): void {
    // Windows 引擎B 不支持暂停（03-§7.3）；服务端回 error.ack UNSUPPORTED
    this.send({ type: 'ctrl', payload: 'pause' });
  }

  reset(): void {
    this.send({ type: 'ctrl', payload: 'reset' });
  }

  input(ev: InputEvent): void {
    if (ev.type === 'uart.tx') {
      this.send({ type: 'input.uart', payload: { bytes: [...ev.bytes] } });
    } else if (ev.type === 'pin.level') {
      this.send({
        type: 'input.pin',
        payload: { partId: ev.partId, pin: ev.pin, level: ev.level },
      });
    } else if (ev.type === 'analog.value') {
      this.send({
        type: 'input.analog',
        payload: { partId: ev.partId, pin: ev.pin, value: ev.value },
      });
    }
  }

  dispose(): void {
    this.closedByUs = true;
    this.send({ type: 'ctrl', payload: 'stop' });
    this.ws?.close();
    this.ws = null;
    this.handlers.clear();
    this.loadResolve = null;
    this.loadReject = null;
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

  private emit<K extends EngineEventType>(type: K, payload: EngineEventMap[K]): void {
    const set = this.handlers.get(type);
    if (set) for (const cb of set) cb(payload);
  }

  private send(m: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m));
    }
  }
}
