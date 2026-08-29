import type { BoardDefinition, CircuitDoc, PartDefinition, PinRef } from '@esp32-sim/shared';

/**
 * PinBus 引脚总线模型（《03-核心模块详细设计》§4，两引擎共用——M4 引擎A 主线程持有）
 *
 * 网络聚合：load() 对 connections 做 Union-Find；板卡左右列同名引脚因 PinRef 不带列
 * 后缀（05-§1.1.1）天然聚合为同一 PinRef，无需特殊处理。
 * 语义边界（06-§2）：仅逻辑拓扑，不做电压/电流求解；电源网络（GND/3V3/5V）为固定电平。
 */

export type Pull = 'up' | 'down' | 'none';
export type Level = 0 | 1;
export type NetId = string;

export type DriverToken = number;
export type ReaderToken = number;

/** PinBus 引脚级事件流（03-§4.1；M4 发电平/PWM/模拟，波形捕获 M11 消费） */
export type PinBusEvent =
  | { kind: 'pin.level'; pinRef: PinRef; level: Level; ts: number }
  | { kind: 'pwm.duty'; pinRef: PinRef; duty: number; freq: number; ts: number }
  | { kind: 'analog.value'; pinRef: PinRef; value: number; ts: number };

interface Net {
  id: NetId;
  members: PinRef[];
  /** 输出驱动 token → 电平（多驱动取最后写入者，冲突告警，§4.2 规则 2） */
  drivers: Map<DriverToken, Level>;
  inputReaders: Set<ReaderToken>;
  pull: Pull;
  /** 模拟注入值（ReaderToken → 0..4095），M4 仅 adcRead 消费 */
  analog: Map<ReaderToken, number>;
  /** 电源语义（§4.2 规则 3）：GND 网络=0、POWER 网络=1，读写均不可覆盖 */
  fixed: Level | null;
  /** 最后写入电平（floating 时读值由 pull 决定） */
  level: Level;
  /** 是否被 injectPin 注入过（注入后 read 直接取 level，不再走 pull） */
  injected: boolean;
}

let nextToken = 1;

class UnionFind {
  private parent = new Map<string, string>();
  makeSet(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    // 路径压缩
    let cur = x;
    while (this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(x: string, y: string): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx !== ry) this.parent.set(rx, ry);
  }

  allKeys(): Iterable<PinRef> {
    // key 全部经 makeSet 注册（仅 PinRef 入口），收窄安全
    return this.parent.keys() as Iterable<PinRef>;
  }
}

export class PinBus {
  private nets = new Map<NetId, Net>();
  private pinToNet = new Map<PinRef, NetId>();
  private driverPin = new Map<DriverToken, PinRef>();
  private levelSubs = new Map<NetId, Set<(level: Level) => void>>();
  private allSubs = new Map<NetId, Set<(ev: PinBusEvent) => void>>();
  private warnHandler: ((text: string) => void) | null = null;

  onWarn(cb: (text: string) => void): void {
    this.warnHandler = cb;
  }

  private warn(text: string): void {
    this.warnHandler?.(text);
  }

  /**
   * 装载电路并聚合网络。board 为板卡 GPIO 映射定义（config/boards），
   * partDefs 为全部 PartInstance 的元件定义（config/parts）。
   */
  load(
    circuit: CircuitDoc,
    board: BoardDefinition,
    partDefs: ReadonlyMap<string, PartDefinition>,
  ): void {
    this.nets.clear();
    this.pinToNet.clear();
    this.driverPin.clear();
    this.levelSubs.clear();
    this.allSubs.clear();

    const uf = new UnionFind();
    const roles = new Map<PinRef, 'gnd' | 'power' | null>();

    const register = (pinRef: PinRef, role: 'gnd' | 'power' | null): void => {
      uf.makeSet(pinRef);
      // 同名/重复注册幂等；gnd 优先于 power（接线错误的保守语义）
      const prev = roles.get(pinRef) ?? null;
      roles.set(pinRef, prev === 'gnd' ? 'gnd' : (role ?? prev));
    };

    // 1) 板卡实例引脚（左右列同名引脚 PinRef 相同，makeSet 幂等自动聚合）
    //    注意：circuit.parts[].type 为 'board-' 前缀元件类型（config/parts），
    //    而 BoardDefinition.type 为短名（config/boards），匹配用 circuit.boardType（01-§7.4.1 N4）
    const boardPart = circuit.parts.find((p) => p.type === circuit.boardType);
    if (boardPart) {
      for (const pin of board.pins) {
        const ref = `${boardPart.id}:${pin.name}` as PinRef;
        const hasGnd = pin.caps.includes('gnd');
        const hasPower = pin.caps.includes('power');
        register(ref, hasGnd ? 'gnd' : hasPower ? 'power' : null);
      }
    }

    // 2) 其余元件实例引脚
    for (const part of circuit.parts) {
      if (part.type === circuit.boardType) continue;
      const def = partDefs.get(part.type);
      if (!def) continue; // 未知类型由 CircuitValidation 校验兜底，这里跳过
      for (const pin of def.pins) {
        register(
          `${part.id}:${pin.name}` as PinRef,
          pin.role === 'gnd' ? 'gnd' : pin.role === 'power' ? 'power' : null,
        );
      }
    }

    // 3) 连线合并
    for (const conn of circuit.connections) {
      uf.makeSet(conn.source as PinRef);
      uf.makeSet(conn.target as PinRef);
      uf.union(conn.source, conn.target);
    }

    // 4) 构建 Net
    for (const ref of uf.allKeys()) {
      const root = uf.find(ref) as NetId;
      let net = this.nets.get(root);
      if (!net) {
        net = {
          id: root,
          members: [],
          drivers: new Map(),
          inputReaders: new Set(),
          pull: 'none',
          analog: new Map(),
          fixed: null,
          level: 0,
          injected: false,
        };
        this.nets.set(root, net);
      }
      net.members.push(ref);
      this.pinToNet.set(ref, root);
    }

    // 5) 电源语义：GND=0，POWER=1（同网络混接时 GND 优先并告警）
    for (const net of this.nets.values()) {
      const hasGnd = net.members.some((r) => roles.get(r) === 'gnd');
      const hasPower = net.members.some((r) => roles.get(r) === 'power');
      if (hasGnd && hasPower) {
        this.warn(`电源短路：网络 ${net.id} 同时连接 GND 与电源引脚，按 GND 处理`);
      }
      net.fixed = hasGnd ? 0 : hasPower ? 1 : null;
      net.level = net.fixed ?? 0;
    }
  }

  // ---- 驱动与读取（§3.2 shim 转发表） ----

  /** 固件 `Pin(n, Pin.OUT)`：注册输出驱动 */
  claimOutput(pinRef: PinRef): DriverToken {
    const net = this.netOf(pinRef);
    const token = nextToken++;
    net.drivers.set(token, net.level);
    this.driverPin.set(token, pinRef);
    return token;
  }

  /** 固件 `Pin(n, Pin.IN, pull)`：注册输入读者 */
  claimInput(pinRef: PinRef, pull: Pull = 'none'): ReaderToken {
    const net = this.netOf(pinRef);
    const token = nextToken++;
    net.inputReaders.add(token);
    // 同网络多输入统一 pull：取最后一次声明（固件约定一致时不影响）
    if (net.fixed === null && net.drivers.size === 0) {
      net.pull = pull;
      // 浮空网络的逻辑电平初始化为 pull 值（与 read() 语义一致），
      // 否则 pull=up 注入 0 时无沿变化，irq 丢失按下沿（M5）
      const lvl: Level = pull === 'up' ? 1 : 0;
      if (net.level !== lvl && !net.injected) {
        net.level = lvl;
        this.emitLevel(net, pinRef);
      }
    }
    return token;
  }

  /** `Pin.value(v)`：写电平 → onChange 广播（去重：相同电平不广播，§4.2 规则 4） */
  write(token: DriverToken, level: Level): void {
    const pinRef = this.driverPin.get(token);
    if (!pinRef) throw new Error(`PinBus: 未知驱动 token ${token}`);
    const net = this.netOf(pinRef);
    if (net.fixed !== null) {
      this.warn(`PinBus: ${pinRef} 属于电源网络（固定电平 ${net.fixed}），写入被忽略`);
      return;
    }
    if (net.drivers.size > 1 && net.level !== level) {
      this.warn(
        `PinBus: 网络 ${net.id} 存在 ${net.drivers.size} 个输出驱动，电平冲突（最后写入者生效）`,
      );
    }
    net.drivers.set(token, level);
    if (net.level !== level) {
      net.level = level;
      this.emitLevel(net, pinRef);
    }
  }

  /** `Pin.value()`：读网络电平；无驱动 floating 时由 pull 决定（up=1，否则 0） */
  read(pinRef: PinRef): Level {
    const net = this.netOf(pinRef);
    if (net.fixed !== null) return net.fixed;
    if (net.drivers.size === 0 && !net.injected) return net.pull === 'up' ? 1 : 0;
    return net.level;
  }

  /** 输入注入（§8.3 按键元件）：不 claim、瞬时改变网络电平并广播 */
  injectPin(pinRef: PinRef, level: Level): void {
    const net = this.netOf(pinRef);
    if (net.fixed !== null) return; // 电源网络不可注入
    net.injected = true;
    if (net.level !== level) {
      net.level = level;
      this.emitLevel(net, pinRef);
    }
  }

  /**
   * 注入解除（05-§1.4 按键松开）：清除注入态，电平回退——
   * 有输出驱动 → 恢复驱动记录电平（一致时）；否则按 pull 决定（up=1，否则 0）；变化才广播。
   */
  releasePin(pinRef: PinRef): void {
    const net = this.netOf(pinRef);
    if (net.fixed !== null || !net.injected) return;
    net.injected = false;
    let level: Level = net.pull === 'up' ? 1 : 0;
    if (net.drivers.size > 0) {
      // net.level 可能已被注入覆盖，恢复值取驱动 token 记录（全部一致时）
      const first = net.drivers.values().next().value as Level;
      let consistent = true;
      for (const l of net.drivers.values()) {
        if (l !== first) {
          consistent = false;
          break;
        }
      }
      if (consistent) level = first;
    }
    if (net.level !== level) {
      net.level = level;
      this.emitLevel(net, pinRef);
    }
  }

  /** 模拟注入（电位器等，0..4095） */
  injectAnalog(pinRef: PinRef, value: number): void {
    const net = this.netOf(pinRef);
    const token = nextToken++;
    net.analog.set(token, value);
    this.emit(net, { kind: 'analog.value', pinRef, value, ts: Date.now() });
  }

  /** `ADC(Pin(n))`：读模拟值，无注入返回 0（05-§1.6 E3） */
  adcRead(pinRef: PinRef): number {
    const net = this.netOf(pinRef);
    let max = 0;
    for (const v of net.analog.values()) max = Math.max(max, v);
    return max;
  }

  /** `UART(0, baud)`：占位（M4 无硬件状态，REPL/stdout 走引擎事件） */
  uartOpen(_port: 0 | 1 | 2, _baud: number): void {
    // 无硬件状态；波特率仅透传给引擎层记录
  }

  /** `PWM(pin, freq, duty)`：触发 pwm.duty 事件（LED 亮度渲染 M5 交付） */
  pwm(pinRef: PinRef, duty: number, freq: number): void {
    const net = this.netOf(pinRef);
    this.emit(net, { kind: 'pwm.duty', pinRef, duty, freq, ts: Date.now() });
  }

  /** 多驱动电平不一致检测（§4.1 conflict） */
  conflict(pinRef: PinRef): boolean {
    const net = this.netOf(pinRef);
    if (net.drivers.size < 2) return false;
    const levels = new Set(net.drivers.values());
    return levels.size > 1;
  }

  // ---- 订阅 ----

  /** 电平变化回调（仅 level 变化触发；网络级广播） */
  onChange(pinRef: PinRef, cb: (level: Level) => void): () => void {
    return this.addSub(this.levelSubs, pinRef, cb);
  }

  /** 全事件订阅（06-§3.1 逻辑分析仪 M11 消费） */
  subscribe(pinRef: PinRef, cb: (ev: PinBusEvent) => void): () => void {
    return this.addSub(this.allSubs, pinRef, cb);
  }

  netOf(pinRef: PinRef): Net {
    const id = this.pinToNet.get(pinRef);
    const net = id ? this.nets.get(id) : undefined;
    if (!net) throw new Error(`PinBus: 未知引脚 ${pinRef}（未在电路中注册）`);
    return net;
  }

  private emitLevel(net: Net, source: PinRef): void {
    this.emit(net, { kind: 'pin.level', pinRef: source, level: net.level, ts: Date.now() });
    const subs = this.levelSubs.get(net.id);
    if (subs) for (const cb of subs) cb(net.level);
  }

  private emit(net: Net, ev: PinBusEvent): void {
    const subs = this.allSubs.get(net.id);
    if (subs) for (const cb of subs) cb(ev);
  }

  private addSub<S>(store: Map<NetId, Set<S>>, pinRef: PinRef, cb: S): () => void {
    const net = this.netOf(pinRef);
    let subs = store.get(net.id);
    if (!subs) {
      subs = new Set();
      store.set(net.id, subs);
    }
    subs.add(cb);
    return () => {
      subs?.delete(cb);
      if (subs && subs.size === 0) store.delete(net.id);
    };
  }
}
