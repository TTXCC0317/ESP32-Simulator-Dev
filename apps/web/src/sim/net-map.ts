import type { CircuitDoc, PartDefinition, PinRef } from '@esp32-sim/shared';
import { boardDefinitionSchema } from '@esp32-sim/shared';
import boardRaw from '../../../../config/boards/esp32-devkit-c-v4.json';
import { PART_INTERNAL_NETS } from './pinbus';

/**
 * 前端网络映射（05-§1.1.1 E1 前端侧，M5 元件行为）：
 * 引脚 PinRef → 网络 BFS（connections + passive 组内合并，与 PinBus.PART_INTERNAL_NETS 一致）
 * → 板卡 GPIO 编号 / 电源语义。供元件运行时渲染（LED/RGB/蜂鸣器，引擎A/B 统一
 * 消费 gpio.write/pwm.duty 的 GPIO 编号）与按键/开关注入信号脚选择（part-input）。
 */

const BOARD_DEF = boardDefinitionSchema.parse(boardRaw);

/** 板卡引脚名 → GPIO 编号（同名引脚左右列共用，PinRef 不带列后缀） */
const GPIO_BY_PIN_NAME = new Map(BOARD_DEF.pins.map((p) => [p.name, p.gpio] as const));

export type NetRole = 'gnd' | 'power';

export interface NetMap {
  /** 引脚所在网络可达的板卡 GPIO 编号（跨导线/电阻/按键组内；多 GPIO 取首个） */
  gpioOf(ref: PinRef): number | null;
  /** 引脚网络的电源语义（任一成员 role 决定；gnd 优先于 power） */
  netRoleOf(ref: PinRef): NetRole | null;
}

export function buildNetMap(
  circuit: CircuitDoc,
  defs: ReadonlyMap<string, PartDefinition>,
): NetMap {
  const boardPartId = circuit.parts.find((p) => p.type === circuit.boardType)?.id ?? null;

  // 邻接表：元件引脚注册 + 连线双向边 + passive 组内双向边
  const adj = new Map<PinRef, Set<PinRef>>();
  const roles = new Map<PinRef, NetRole>();
  const link = (a: PinRef, b: PinRef): void => {
    let sa = adj.get(a);
    if (!sa) adj.set(a, (sa = new Set()));
    sa.add(b);
    let sb = adj.get(b);
    if (!sb) adj.set(b, (sb = new Set()));
    sb.add(a);
  };

  for (const part of circuit.parts) {
    const def = defs.get(part.type);
    if (!def) continue;
    for (const pin of def.pins) {
      const ref = `${part.id}:${pin.name}` as PinRef;
      if (!adj.has(ref)) adj.set(ref, new Set());
      if (pin.role === 'gnd' || pin.role === 'power') {
        roles.set(ref, pin.role);
      }
    }
    const groups = PART_INTERNAL_NETS[part.type];
    if (groups) {
      for (const group of groups) {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            link(`${part.id}:${group[i]}` as PinRef, `${part.id}:${group[j]}` as PinRef);
          }
        }
      }
    }
  }
  for (const conn of circuit.connections) {
    link(conn.source, conn.target);
  }

  const boardGpio = (ref: PinRef): number | null => {
    if (!boardPartId) return null;
    const prefix = `${boardPartId}:`;
    if (!ref.startsWith(prefix)) return null;
    return GPIO_BY_PIN_NAME.get(ref.slice(prefix.length)) ?? null;
  };

  /** BFS 网络成员遍历（未知引脚即孤立网络） */
  function members(ref: PinRef): Iterable<PinRef> {
    const seen = new Set<PinRef>([ref]);
    const queue = [ref];
    while (queue.length) {
      const cur = queue.shift() as PinRef;
      for (const nxt of adj.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          queue.push(nxt);
        }
      }
    }
    return seen;
  }

  return {
    gpioOf(ref: PinRef): number | null {
      for (const m of members(ref)) {
        const gpio = boardGpio(m);
        if (gpio !== null) return gpio;
      }
      return null;
    },
    netRoleOf(ref: PinRef): NetRole | null {
      let power: NetRole | null = null;
      for (const m of members(ref)) {
        const role = roles.get(m) ?? null;
        if (role === 'gnd') return 'gnd';
        if (role === 'power') power = 'power';
      }
      return power;
    },
  };
}
