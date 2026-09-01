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

/**
 * 电位器 value 改变（05-§1.6 电位器行为，M7）：
 * - VCC 网络需有 power 语义、GND 网络需有 gnd 语义；未接电源则不注入且返回 false（上层显示提示）
 * - valuePercent: 0–100（来自 attrs.value）→ 注入值 = round(valuePercent / 100 * 4095)
 * - SIG 引脚 = "SIG"（引脚名由 part JSON 定义固定，候选引脚 "SIG"）
 * 返回 true 表示注入成功（VCC/GND 已正确接），false 表示未接电源
 */
export function setPotentiometerValue(partId: string, valuePercent: number): boolean {
  if (!runtimeActive()) return false;
  const net = netMap();
  const vccRole = net.netRoleOf(`${partId}:VCC` as PinRef);
  const gndRole = net.netRoleOf(`${partId}:GND` as PinRef);
  // 电源校验：VCC 必须可达 power 网络；GND 必须可达 gnd 网络；否则不注入
  if (vccRole !== 'power' || gndRole !== 'gnd') return false;
  const sigRef = `${partId}:SIG`;
  // net-map 校验 SIG 引脚存在（避免 typo），否则 false
  if (net.gpioOf(sigRef as PinRef) === null && net.netRoleOf(sigRef as PinRef) === null)
    return false;
  const clamped = Math.max(0, Math.min(100, valuePercent));
  const value = Math.round((clamped / 100) * 4095);
  emit({ type: 'analog.value', partId, pin: 'SIG', value });
  return true;
}

/**
 * I2C/SPI 传感器注入（M8 05-§4.x sensor.data）：
 * 用户在 Inspector 调 BH1750/MPU6050 等 attrs（lux/accelX/gyroZ…）时，
 * 将字段聚合为 sensor.data 输入事件发往引擎：
 * - 引擎A（wasm shim 未实现前）：仅 log warn 占位（不影响 PinBus 状态）
 * - 引擎B（QEMU+glue）：ws-gateway 收 i2c.txn/spi.txn 时，按 computeI2cReply 计算
 *   寄存器字节；sensor.data 暂不影响引擎B（attrs 是前端 store 的"输入旋钮"，
 *   ws-gateway 走的是 catalog.parts_catalog 里 DeviceSpec.defaultBytes，
 *   运行期不可变）。本函数仅作为前端 → 引擎A 的预留接口。
 */
export function setSensorData(partId: string, data: Record<string, number>): void {
  if (!runtimeActive()) return;
  emit({ type: 'sensor.data', partId, data });
}
