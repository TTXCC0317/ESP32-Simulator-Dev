import type { InputEvent, PinRef } from '@esp32-sim/shared';
import { P1_CATALOG } from '../circuit/catalog-data';
import { useCircuitStore } from '../circuit/circuitStore';
import { simSession, useSimStore } from '../stores/sim';
import { buildNetMap, type NetMap } from './net-map';

/**
 * 元件输入注入（05-§1.4 momentary-switch / §1.7 toggle-switch，M5 双引擎）：
 * 画布按键/开关交互 → engine.input(pin.level)。
 * - 引擎A：PinBus.injectPin/releasePin（worker 内）；
 * - 引擎B：WS input.pin（服务端 GPIO 桥 resolveGpio → UART1 注入）。
 *
 * 信号脚自动选择（05-§1.4「按下时将 1.l 与 2.l 置为同网络」的注入实现）：
 * 在候选引脚中选 BFS 可达板卡 GPIO 的脚，注入电平取对侧网络的电源语义
 * （对侧接 GND → 0、接 3V3 → 1、悬空 → 0），两引擎一致。
 */

/** 运行中才允许注入（idle/loading 时点击元件走选择/移动） */
function runtimeActive(): boolean {
  const st = useSimStore.getState().status;
  return st === 'running' || st === 'paused';
}

function netMap(): NetMap {
  return buildNetMap(useCircuitStore.getState().doc, P1_CATALOG);
}

function emit(ev: InputEvent): void {
  simSession.engine?.input(ev);
}

function inject(pinRef: { partId: string; pin: string }, level: 0 | 1): void {
  emit({ type: 'pin.level', partId: pinRef.partId, pin: pinRef.pin, level });
}

function release(pinRef: { partId: string; pin: string }): void {
  emit({ type: 'pin.level', partId: pinRef.partId, pin: pinRef.pin, level: 0, release: true });
}

/** 对侧网络电源语义 → 注入电平（gnd/power 之外默认 0） */
function levelOfOpposite(net: NetMap, ref: string): 0 | 1 {
  return net.netRoleOf(ref as PinRef) === 'power' ? 1 : 0;
}

/**
 * 按键按下。候选组代表 1.l / 2.l（组内 1.r / 2.r 经 passive 合并同网络）：
 * 信号脚 = 可达板卡 GPIO 的组；注入电平 = 对组网络电源语义。
 */
export function pressButton(partId: string): void {
  if (!runtimeActive()) return;
  const net = netMap();
  const g1 = net.gpioOf(`${partId}:1.l`);
  const g2 = net.gpioOf(`${partId}:2.l`);
  let signal: string;
  let opposite: string;
  if (g1 !== null) {
    signal = '1.l';
    opposite = '2.l';
  } else if (g2 !== null) {
    signal = '2.l';
    opposite = '1.l';
  } else {
    // 兜底：默认接法（信号 1.l，对脚 2.l）
    signal = '1.l';
    opposite = '2.l';
  }
  inject({ partId, pin: signal }, levelOfOpposite(net, `${partId}:${opposite}`));
}

/** 按键松开：对信号脚解除注入（引擎侧回退 pull 电平） */
export function releaseButton(partId: string): void {
  if (!runtimeActive()) return;
  const net = netMap();
  const signal = net.gpioOf(`${partId}:2.l`) !== null ? '2.l' : '1.l';
  release({ partId, pin: signal });
}

/**
 * 滑动开关切换到 position（'1' → 1↔2 通；'2' → 2↔3 通，05-§1.7）：
 * 信号脚 = 可达板卡 GPIO 的脚；导通对 = 位置决定；信号脚不在对内或
 * 对脚网络悬空（无 gnd/power 语义）→ 释放（GPIO 未被驱动，回退 pull 电平）。
 */
export function toggleSwitch(partId: string, position: '1' | '2'): void {
  if (!runtimeActive()) return;
  const net = netMap();
  let signal: string | null = null;
  for (const name of ['1', '2', '3'] as const) {
    if (net.gpioOf(`${partId}:${name}`) !== null) {
      signal = name;
      break;
    }
  }
  if (!signal) signal = '2'; // 兜底：公共端 2
  // 位置导通对：'1'↔{1,2}；'2'↔{2,3}；信号脚不在对内 → 不导通 → 释放
  const pair: Record<'1' | '2', readonly [string, string]> = {
    '1': ['1', '2'],
    '2': ['2', '3'],
  };
  const [a, b] = pair[position];
  const opposite = signal === a ? b : signal === b ? a : null;
  const role = opposite ? net.netRoleOf(`${partId}:${opposite}` as PinRef) : null;
  if (opposite && role !== null) {
    inject({ partId, pin: signal }, role === 'power' ? 1 : 0);
  } else {
    release({ partId, pin: signal });
  }
}
