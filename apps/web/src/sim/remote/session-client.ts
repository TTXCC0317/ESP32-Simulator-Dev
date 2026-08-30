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
import { useErrorsStore } from '../../stores/errors';
import { useProjectStore } from '../../stores/project';
import { useSimStore, type SimStatus } from '../../stores/sim';
import { parseCompileLine } from '../problems';

/**
 * RemoteSessionClient（03-§6.3 + §7.3/§7.4 引擎B 前端消费侧）：
 * SimulationEngine 接口 → 引擎B WS 会话（/ws/sim/:sid）。
 * load：POST /api/build → WS attach → build.progress 推送 → state running 时 resolve；
 * N2 映射：attaching→loading、building-wait→building、closed→idle；
 * 串口/输入：uart.tx → input.uart；pin.level/analog.value → input.pin/input.analog（M5 GPIO 桥消费）；
 * 错误面板（04-§9，M6）：编译 critical 行（定位解析）、state error、log error、error.ack、断线 → errorsStore；
 * 断线重连（06-§7.1 F1）：running 后断线按 1/2/4/8/16s 指数退避重连 ≤5 次（同 sid attach 接管）；
 * 心跳（06-§7.1.1 N20）：15s 应用层 ping，45s 未 pong 主动 close 触发重连。
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

/** 断线重连退避（06-§7.1 表）：1/2/4/8/16s，5 次失败后停止并提示 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** 心跳参数（06-§7.1.1 表：15s 发送 / 45s 失活判定 / 5s 检查） */
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_LOSS_MS = 45_000;
const HEARTBEAT_CHECK_MS = 5_000;

export class RemoteSessionClient implements SimulationEngine {
  readonly kind = 'qemu-remote' as const;

  private ws: WebSocket | null = null;
  private sid: string;
  private closedByUs = false;
  private handlers = new Map<EngineEventType, Set<Handler<EngineEventType>>>();
  private loadResolve: (() => void) | null = null;
  private loadReject: ((err: Error) => void) | null = null;
  /** 断线重连（F1）：attach 参数留存 + running 确立标记 + 退避序号 */
  private lastAttach: {
    projectId: string;
    circuit: CircuitDoc;
    buildId: string;
    boardType: string;
  } | null = null;
  private hasRun = false;
  private retryIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 心跳（N20）：ping 定时器 + 失活检查定时器 + 最近 pong 时间 */
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private hbCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongTs = 0;

  constructor() {
    this.sid = `s-${crypto.randomUUID().slice(0, 8)}`;
  }

  async load(circuit: CircuitDoc, fw: FirmwareInput): Promise<void> {
    if (fw.kind !== 'sources') throw new Error('引擎B 前端仅提交源码（固件由服务端编译）');
    const projectId = useProjectStore.getState().current?.id;
    if (!projectId) throw new Error('未打开工程');

    // 1) 提交编译（202 + buildId；排队/执行由 BuildService 队列控制）
    const { buildId } = await api.submitBuild({ projectId, toolchain: 'arduino' });

    // 2) WS attach（onopen 发送）→ 等 state running（编译 success → QEMU spawn 后到达）；
    //    open 阶段失败由 onclose → fail() 同步 reject（重跑可复用编译产物，不退避）
    return new Promise<void>((resolve, reject) => {
      this.loadResolve = resolve;
      this.loadReject = reject;
      this.dial({ projectId, circuit, buildId, boardType: circuit.boardType });
    });
  }

  /** 建立 WS 连接 + onopen attach（初次 load 与断线重连共用） */
  private dial(p: {
    projectId: string;
    circuit: CircuitDoc;
    buildId: string;
    boardType: string;
  }): void {
    const ws = new WebSocket(`${WS_BASE}/ws/sim/${this.sid}`);
    this.ws = ws;
    ws.onopen = () => {
      this.lastAttach = p;
      this.startHeartbeat();
      this.send({
        type: 'attach',
        payload: {
          projectId: p.projectId,
          circuit: p.circuit,
          firmwareId: p.buildId,
          boardType: p.boardType,
        },
      });
    };
    ws.onmessage = (e) => this.onMessage(e.data as string);
    ws.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      if (this.closedByUs) return;
      if (!this.hasRun) {
        // 首连失败（load 阶段）：立即报错，不做重连退避（重新运行由用户触发，可复用编译产物）
        this.fail(new Error('引擎B 会话连接断开（重新运行可复用编译产物）'));
        return;
      }
      this.handleDisconnect();
    };
    ws.onerror = () => {
      // onclose 随后触发，错误统一在 onclose 上报
    };
  }

  private fail(err: Error): void {
    useSimStore.getState().setStatus('error', err.message);
    useErrorsStore.getState().push({
      source: 'session',
      severity: 'error',
      title: '引擎B 会话错误',
      detail: err.message,
    });
    // load 阶段断线：同步终止 load 等待（running 后 reject 已 settled，无副作用）
    this.loadReject?.(err);
    this.loadResolve = null;
    this.loadReject = null;
  }

  /** running 后断线（F1）：指数退避重连，重连期间 UI 停留在 loading（N2 映射） */
  private handleDisconnect(): void {
    const delay = RECONNECT_DELAYS_MS[this.retryIndex];
    this.retryIndex += 1;
    if (delay === undefined) {
      // 退避耗尽（5 次失败）→ 停止重连并报会话错误
      this.retryIndex = 0;
      this.fail(new Error('会话已断开（重连 5 次失败），请点击重试或重新运行'));
      return;
    }
    useSimStore
      .getState()
      .setStatus(
        'loading',
        `连接断开，${delay / 1000}s 后重连（${this.retryIndex}/${RECONNECT_DELAYS_MS.length}）`,
      );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUs || !this.lastAttach) return;
      this.dial(this.lastAttach);
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongTs = Date.now();
    this.hbTimer = setInterval(() => {
      this.send({ type: 'ping', ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
    this.hbCheckTimer = setInterval(() => {
      // 失活判定（N20）：45s 未 pong 主动 close → onclose 触发重连流程
      if (Date.now() - this.lastPongTs > HEARTBEAT_LOSS_MS) this.ws?.close();
    }, HEARTBEAT_CHECK_MS);
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.hbCheckTimer) clearInterval(this.hbCheckTimer);
    this.hbTimer = null;
    this.hbCheckTimer = null;
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
      case 'pong':
        this.lastPongTs = Date.now();
        break;
      case 'state': {
        const st = STATE_TO_STATUS[msg.payload.status] ?? 'error';
        useSimStore.getState().setStatus(st, msg.payload.error);
        // 'building' 是 UI 层扩展（EngineStatus 无此值）：事件侧按 loading 语义发布
        this.emit('state', {
          status: st === 'building' ? 'loading' : st,
          error: msg.payload.error,
        });
        if (msg.payload.status === 'running') {
          this.hasRun = true;
          this.retryIndex = 0; // 重连成功，退避复位
          this.loadResolve?.();
        } else if (msg.payload.status === 'error') {
          useErrorsStore.getState().push({
            source: 'engine',
            severity: 'error',
            title: '引擎B 运行错误',
            ...(msg.payload.error ? { detail: msg.payload.error } : {}),
          });
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
        // QEMU/宿主错误聚合到问题面板（04-§9）
        if (msg.payload.level === 'error') {
          useErrorsStore.getState().push({
            source: 'engine',
            severity: 'error',
            title: 'QEMU/宿主错误',
            detail: msg.payload.text,
          });
        }
        this.emit('log', msg.payload);
        break;
      case 'build.progress': {
        useSimStore.getState().setBuild({
          phase: msg.payload.phase,
          progress: msg.payload.progress,
        });
        const lines = [
          ...(msg.payload.logLine !== undefined ? [msg.payload.logLine] : []),
          ...(msg.payload.logLines ?? []),
        ];
        for (const line of lines) {
          // 编译诊断行（file:line:col）→ 问题面板定位条目（04-§9）
          const diag = parseCompileLine(line);
          if (diag) {
            useErrorsStore.getState().push({
              source: 'build',
              severity: diag.severity,
              title: diag.message,
              file: diag.file,
              line: diag.line,
              col: diag.col,
            });
          }
          // critical 行（error/warning）→ warn 级日志
          if (msg.payload.logLine !== undefined) {
            this.emit('log', { level: 'warn', text: line });
          } else {
            this.emit('log', { level: 'info', text: line });
          }
        }
        if (msg.payload.phase === 'failed') {
          useErrorsStore.getState().push({
            source: 'build',
            severity: 'error',
            title: '编译失败',
            ...(msg.payload.error ? { detail: msg.payload.error } : {}),
          });
          this.loadReject?.(new Error(msg.payload.error ?? '编译失败'));
          this.loadResolve = null;
          this.loadReject = null;
        }
        break;
      }
      case 'error.ack':
        useErrorsStore.getState().push({
          source: 'session',
          severity: 'error',
          title: `[${msg.payload.code}] ${msg.payload.message}`,
        });
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
        payload: {
          partId: ev.partId,
          pin: ev.pin,
          level: ev.level,
          ...(ev.release ? { release: true } : {}),
        },
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
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
