import { describe, it, expect } from 'vitest';
import type { CircuitDoc, PinRef } from '@esp32-sim/shared';
import { P1_CATALOG } from '../circuit/catalog-data';
import { buildNetMap } from './net-map';

/**
 * L1（02-§4 M5 测试项）：前端网络映射 net-map
 * PinRef → 网络 BFS（connections + passive 组内合并）→ 板卡 GPIO / 电源语义。
 * 使用真实 P1_CATALOG（config/parts + config/boards 同源）。
 */

type ConnInput = Omit<CircuitDoc['connections'][number], 'source' | 'target'> & {
  source: string;
  target: string;
};

function makeCircuit(connections: ConnInput[]): CircuitDoc {
  return {
    formatVersion: 1,
    boardType: 'board-esp32-devkit-c-v4',
    parts: [
      { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 0, top: 0, rotate: 0, attrs: {} },
      { id: 'led1', type: 'wokwi-led', left: 300, top: 100, rotate: 0, attrs: {} },
      { id: 'btn1', type: 'wokwi-pushbutton', left: 300, top: 220, rotate: 0, attrs: {} },
      { id: 'res1', type: 'wokwi-resistor', left: 300, top: 320, rotate: 0, attrs: {} },
      { id: 'sw1', type: 'wokwi-slide-switch', left: 300, top: 400, rotate: 0, attrs: {} },
    ],
    connections: connections.map((c) => ({
      ...c,
      source: c.source as PinRef,
      target: c.target as PinRef,
    })),
    serialMonitor: { baudrate: 115200 },
  };
}

describe('net-map gpioOf（PinRef → 板卡 GPIO）', () => {
  it('直连：GPIO4 → LED.A → 4', () => {
    const net = buildNetMap(
      makeCircuit([{ id: 'w1', source: 'esp:GPIO4', target: 'led1:A', color: 'green', path: [] }]),
      P1_CATALOG,
    );
    expect(net.gpioOf('led1:A')).toBe(4);
    expect(net.gpioOf('esp:GPIO4')).toBe(4);
  });

  it('跨电阻（passive 直通）：GPIO4 → R.1，R.2 → LED.A → 4（05-§1.5 E2）', () => {
    const net = buildNetMap(
      makeCircuit([
        { id: 'w1', source: 'esp:GPIO4', target: 'res1:1', color: 'green', path: [] },
        { id: 'w2', source: 'res1:2', target: 'led1:A', color: 'green', path: [] },
      ]),
      P1_CATALOG,
    );
    expect(net.gpioOf('led1:A')).toBe(4);
    expect(net.gpioOf('res1:2')).toBe(4);
  });

  it('按键组内合并：信号在 1.l 组、2.l 组对侧独立（05-§1.4）', () => {
    const net = buildNetMap(
      makeCircuit([
        { id: 'w1', source: 'esp:GPIO4', target: 'btn1:1.l', color: 'green', path: [] },
        { id: 'w2', source: 'btn1:2.l', target: 'esp:GND.1', color: 'black', path: [] },
      ]),
      P1_CATALOG,
    );
    expect(net.gpioOf('btn1:1.l')).toBe(4);
    expect(net.gpioOf('btn1:1.r')).toBe(4); // 组内常通
    expect(net.gpioOf('btn1:2.l')).toBeNull(); // GND 网络无 GPIO
  });

  it('滑动开关（无静态合并）：GPIO4 → sw.2 → 4', () => {
    const net = buildNetMap(
      makeCircuit([{ id: 'w1', source: 'esp:GPIO4', target: 'sw1:2', color: 'green', path: [] }]),
      P1_CATALOG,
    );
    expect(net.gpioOf('sw1:2')).toBe(4);
    expect(net.gpioOf('sw1:1')).toBeNull();
  });

  it('未连接引脚 → null；板卡未知 GPIO 引脚（EN）→ null', () => {
    const net = buildNetMap(makeCircuit([]), P1_CATALOG);
    expect(net.gpioOf('btn1:1.l')).toBeNull();
    expect(net.gpioOf('esp:EN')).toBeNull();
  });
});

describe('net-map netRoleOf（电源语义）', () => {
  it('LED.C → GND.1 → gnd；按键对脚接 3V3 → power', () => {
    const net = buildNetMap(
      makeCircuit([
        { id: 'w1', source: 'led1:C', target: 'esp:GND.1', color: 'black', path: [] },
        { id: 'w2', source: 'btn1:2.l', target: 'esp:3V3', color: 'red', path: [] },
      ]),
      P1_CATALOG,
    );
    expect(net.netRoleOf('led1:C')).toBe('gnd');
    expect(net.netRoleOf('btn1:2.l')).toBe('power');
    expect(net.netRoleOf('btn1:1.l')).toBeNull();
  });

  it('gnd 优先于 power（同网络混接保守语义，与 PinBus 一致）', () => {
    const net = buildNetMap(
      makeCircuit([
        { id: 'w1', source: 'led1:C', target: 'esp:GND.1', color: 'black', path: [] },
        { id: 'w2', source: 'led1:C', target: 'esp:3V3', color: 'red', path: [] },
      ]),
      P1_CATALOG,
    );
    expect(net.netRoleOf('led1:C')).toBe('gnd');
  });
});
