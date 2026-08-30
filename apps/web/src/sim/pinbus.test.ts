import { describe, it, expect, vi } from 'vitest';
import type { BoardDefinition, CircuitDoc, PartDefinition, PinRef } from '@esp32-sim/shared';
import { PinBus } from './pinbus';

/** 测试便利类型：source/target 用 string 字面量书写，makeCircuit 内部收窄为 PinRef */
type ConnInput = Omit<CircuitDoc['connections'][number], 'source' | 'target'> & {
  source: string;
  target: string;
};

/** 板卡：左列 VP + 右列同名 VP（05-§1.1.1 聚合基础）+ GPIO4 + GND + 3V3 */
const board: BoardDefinition = {
  type: 'esp32-devkit-c-v4',
  name: 'ESP32 DevKit-C V4',
  mcu: 'esp32',
  arch: 'xtensa',
  engines: ['micropython-wasm', 'qemu-remote'],
  pins: [
    { name: 'VP', gpio: 36, x: 8, y: 50, caps: ['gpio', 'adc'], col: 'L' },
    { name: 'GPIO4', gpio: 4, x: 8, y: 68, caps: ['gpio', 'pwm', 'adc'], col: 'L' },
    { name: 'GND.1', gpio: 0, x: 232, y: 32, caps: ['gnd'], col: 'R' },
    { name: '3V3', gpio: 0, x: 232, y: 50, caps: ['power'], col: 'R' },
    { name: 'VP', gpio: 36, x: 232, y: 68, caps: ['gpio', 'adc'], col: 'R' },
  ],
};

const ledDef: PartDefinition = {
  type: 'wokwi-led',
  name: 'LED',
  category: 'io',
  defVersion: 1,
  pins: [
    { name: 'A', role: 'signal.in', x: 20, y: 0 },
    { name: 'C', role: 'gnd', x: 20, y: 62 },
  ],
  attrs: [],
  renderer: { asset: 'led.svg', width: 40, height: 62 },
  simulator: { listens: ['gpio.write', 'pwm.duty'], behavior: '亮灭随电平' },
};

const btnDef: PartDefinition = {
  type: 'wokwi-pushbutton',
  name: '按键',
  category: 'io',
  defVersion: 1,
  pins: [
    { name: '1.l', role: 'passive', x: 0, y: 20 },
    { name: '2.l', role: 'passive', x: 68, y: 20 },
  ],
  attrs: [],
  renderer: { asset: 'pushbutton.svg', width: 68, height: 68 },
  simulator: { listens: [], produces: ['pin.level'], behavior: '按下导通' },
};

const resDef: PartDefinition = {
  type: 'wokwi-resistor',
  name: '电阻',
  category: 'io',
  defVersion: 1,
  pins: [
    { name: '1', role: 'passive', x: 0, y: 14 },
    { name: '2', role: 'passive', x: 72, y: 14 },
  ],
  attrs: [],
  renderer: { asset: 'resistor.svg', width: 72, height: 28 },
  simulator: { listens: [], behavior: 'passive-through' },
};

const partDefs = new Map([
  ['wokwi-led', ledDef],
  ['wokwi-pushbutton', btnDef],
  ['wokwi-resistor', resDef],
]);

function makeCircuit(connections: ConnInput[] = []): CircuitDoc {
  return {
    formatVersion: 1,
    boardType: 'board-esp32-devkit-c-v4',
    parts: [
      { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 0, top: 0, rotate: 0, attrs: {} },
      { id: 'led1', type: 'wokwi-led', left: 300, top: 100, rotate: 0, attrs: {} },
      { id: 'btn1', type: 'wokwi-pushbutton', left: 300, top: 220, rotate: 0, attrs: {} },
      { id: 'res1', type: 'wokwi-resistor', left: 300, top: 320, rotate: 0, attrs: {} },
    ],
    connections: connections.map((c) => ({
      ...c,
      source: c.source as PinRef,
      target: c.target as PinRef,
    })),
    serialMonitor: { baudrate: 115200 },
  };
}

const gpio4ToLed = {
  id: 'w1',
  source: 'esp:GPIO4',
  target: 'led1:A',
  color: 'green' as const,
  path: [],
};

describe('PinBus 网络聚合（03-§4.2.1 Union-Find）', () => {
  it('connection 两端同网络：写 GPIO4 可从 led1:A 读到', () => {
    const bus = new PinBus();
    bus.load(makeCircuit([gpio4ToLed]), board, partDefs);
    const t = bus.claimOutput('esp:GPIO4');
    bus.write(t, 1);
    expect(bus.read('led1:A')).toBe(1);
    bus.write(t, 0);
    expect(bus.read('led1:A')).toBe(0);
  });

  it('板卡左右列同名引脚（esp:VP）聚合为同一网络（05-§1.1.1）', () => {
    const bus = new PinBus();
    bus.load(makeCircuit(), board, partDefs);
    const t = bus.claimOutput('esp:VP');
    bus.write(t, 1);
    expect(bus.read('esp:VP')).toBe(1);
    expect(bus.conflict('esp:VP')).toBe(false);
  });

  it('未知 PinRef 抛错（早暴露固件/电路不一致）', () => {
    const bus = new PinBus();
    bus.load(makeCircuit(), board, partDefs);
    expect(() => bus.claimOutput('esp:NOPE')).toThrow();
    expect(() => bus.read('ghost:X')).toThrow();
  });
});

describe('PinBus 多驱动冲突（§4.2 规则 2）', () => {
  it('两驱动写不同电平 → 告警 + 最后写入者生效', () => {
    const warnings: string[] = [];
    const bus = new PinBus();
    bus.onWarn((text) => warnings.push(text));
    bus.load(makeCircuit([gpio4ToLed]), board, partDefs);
    const t1 = bus.claimOutput('esp:GPIO4');
    const t2 = bus.claimOutput('led1:A');
    bus.write(t1, 1);
    bus.write(t2, 0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(bus.conflict('esp:GPIO4')).toBe(true);
    expect(bus.read('esp:GPIO4')).toBe(0); // 最后写入者
  });
});

describe('PinBus 开路与上拉（§4.2 规则 / L1 用例）', () => {
  it('无驱动 floating 网络：pull=none 读 0', () => {
    const bus = new PinBus();
    bus.load(makeCircuit(), board, partDefs);
    bus.claimInput('btn1:1.l');
    expect(bus.read('btn1:1.l')).toBe(0);
  });

  it('上拉语义：pull=up 读 1，注入 0 后读 0（按键接地典型用法）', () => {
    const bus = new PinBus();
    bus.load(makeCircuit(), board, partDefs);
    bus.claimInput('btn1:1.l', 'up');
    expect(bus.read('btn1:1.l')).toBe(1);
    bus.injectPin('btn1:1.l', 0);
    expect(bus.read('btn1:1.l')).toBe(0);
  });
});

describe('PinBus 事件（onChange 去重 + 网络级广播）', () => {
  it('重复电平写不广播（§4.2 规则 4）', () => {
    const bus = new PinBus();
    bus.load(makeCircuit([gpio4ToLed]), board, partDefs);
    const cb = vi.fn();
    bus.onChange('led1:A', cb);
    const t = bus.claimOutput('esp:GPIO4');
    bus.write(t, 1);
    bus.write(t, 1);
    bus.write(t, 1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1);
  });

  it('subscribe 收到 pin.level 事件流（含 ts）', () => {
    const bus = new PinBus();
    bus.load(makeCircuit([gpio4ToLed]), board, partDefs);
    const events: string[] = [];
    bus.subscribe('esp:GPIO4', (ev) => events.push(ev.kind));
    const t = bus.claimOutput('esp:GPIO4');
    bus.write(t, 1);
    bus.write(t, 0);
    expect(events).toEqual(['pin.level', 'pin.level']);
  });
});

describe('PinBus 电源语义（§4.2 规则 3）', () => {
  it('GND 网络固定 0、3V3 固定 1，写入被忽略并告警', () => {
    const bus = new PinBus();
    const warnings: string[] = [];
    bus.onWarn((text) => warnings.push(text));
    bus.load(
      makeCircuit([{ id: 'w2', source: 'led1:C', target: 'esp:GND.1', color: 'black', path: [] }]),
      board,
      partDefs,
    );
    expect(bus.read('led1:C')).toBe(0);
    expect(bus.read('esp:3V3')).toBe(1);
    const t = bus.claimOutput('led1:C');
    bus.write(t, 1);
    expect(bus.read('led1:C')).toBe(0);
    expect(warnings.some((w) => w.includes('电源网络'))).toBe(true);
  });

  it('GND 与电源混接 → 告警并按 GND 处理', () => {
    const bus = new PinBus();
    const warnings: string[] = [];
    bus.onWarn((text) => warnings.push(text));
    bus.load(
      makeCircuit([
        { id: 'w1', source: 'led1:C', target: 'esp:GND.1', color: 'black', path: [] },
        { id: 'w2', source: 'led1:A', target: 'esp:3V3', color: 'red', path: [] },
        { id: 'w3', source: 'led1:A', target: 'esp:GND.1', color: 'black', path: [] },
      ]),
      board,
      partDefs,
    );
    expect(warnings.some((w) => w.includes('电源短路'))).toBe(true);
    expect(bus.read('led1:A')).toBe(0);
  });
});

describe('PinBus 注入与模拟值', () => {
  it('injectPin 瞬时注入并广播（§8.3）', () => {
    const bus = new PinBus();
    bus.load(makeCircuit(), board, partDefs);
    const cb = vi.fn();
    bus.onChange('btn1:2.l', cb);
    bus.injectPin('btn1:2.l', 1);
    expect(bus.read('btn1:2.l')).toBe(1);
    expect(cb).toHaveBeenCalledWith(1);
  });

  it('injectAnalog → adcRead 返回注入值，无注入返回 0（05-§1.6 E3）', () => {
    const bus = new PinBus();
    bus.load(makeCircuit(), board, partDefs);
    expect(bus.adcRead('esp:VP')).toBe(0);
    bus.injectAnalog('esp:VP', 2048);
    expect(bus.adcRead('esp:VP')).toBe(2048);
  });

  it('pwm 触发 pwm.duty 事件', () => {
    const bus = new PinBus();
    bus.load(makeCircuit([gpio4ToLed]), board, partDefs);
    const events: Array<{ duty: number; freq: number }> = [];
    bus.subscribe('led1:A', (ev) => {
      if (ev.kind === 'pwm.duty') events.push({ duty: ev.duty, freq: ev.freq });
    });
    bus.pwm('esp:GPIO4', 512, 1000);
    expect(events).toEqual([{ duty: 512, freq: 1000 }]);
  });
});

describe('PinBus 注入解除（M5 releasePin，05-§1.4 按键松开）', () => {
  it('释放后回退 pull 电平并广播（pull=up：claim 广播 1 → 注入 0 → release → 1）', () => {
    const bus = new PinBus();
    bus.load(makeCircuit(), board, partDefs);
    const cb = vi.fn();
    bus.onChange('btn1:1.l', cb);
    bus.claimInput('btn1:1.l', 'up');
    // claim 时浮空网络初始化为 pull 电平并广播（0→1，保证后续注入有沿变化）
    expect(cb).toHaveBeenNthCalledWith(1, 1);
    bus.injectPin('btn1:1.l', 0);
    expect(bus.read('btn1:1.l')).toBe(0);
    bus.releasePin('btn1:1.l');
    expect(bus.read('btn1:1.l')).toBe(1);
    expect(cb).toHaveBeenCalledTimes(3);
    expect(cb).toHaveBeenLastCalledWith(1);
  });

  it('释放后 pull=none 回 0；未注入网络 release 无操作', () => {
    const bus = new PinBus();
    bus.load(makeCircuit(), board, partDefs);
    const cb = vi.fn();
    bus.onChange('btn1:1.l', cb);
    bus.injectPin('btn1:1.l', 1);
    bus.releasePin('btn1:1.l');
    expect(bus.read('btn1:1.l')).toBe(0);
    // 再次 release：已无注入态，不广播
    bus.releasePin('btn1:1.l');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('网络有输出驱动时 release 保持驱动电平', () => {
    const bus = new PinBus();
    bus.load(makeCircuit([gpio4ToLed]), board, partDefs);
    bus.claimInput('led1:A', 'up');
    const t = bus.claimOutput('esp:GPIO4');
    bus.write(t, 1);
    bus.injectPin('led1:A', 0);
    bus.releasePin('led1:A');
    expect(bus.read('led1:A')).toBe(1); // 驱动电平保持，不回 pull
  });

  it('电源网络 release 无操作（GND 固定电平不可解除）', () => {
    const bus = new PinBus();
    bus.load(
      makeCircuit([{ id: 'w2', source: 'led1:C', target: 'esp:GND.1', color: 'black', path: [] }]),
      board,
      partDefs,
    );
    bus.releasePin('led1:C');
    expect(bus.read('led1:C')).toBe(0);
  });
});

describe('PinBus passive 组内合并（M5，05-§1.5 E2 直通 / §1.4 按键组内）', () => {
  it('电阻 1↔2 直通：GPIO4 → R.1，R.2 → LED.A，写 GPIO4 从 led1:A 读到（跨电阻传播）', () => {
    const bus = new PinBus();
    bus.load(
      makeCircuit([
        { id: 'w1', source: 'esp:GPIO4', target: 'res1:1', color: 'green', path: [] },
        { id: 'w2', source: 'res1:2', target: 'led1:A', color: 'green', path: [] },
        { id: 'w3', source: 'led1:C', target: 'esp:GND.1', color: 'black', path: [] },
      ]),
      board,
      partDefs,
    );
    const t = bus.claimOutput('esp:GPIO4');
    bus.write(t, 1);
    expect(bus.read('led1:A')).toBe(1);
    // 电阻两端同网络 → 两端各接一个输出视为多驱动冲突（E2）
    const t2 = bus.claimOutput('led1:A');
    bus.write(t2, 0);
    expect(bus.conflict('esp:GPIO4')).toBe(true);
  });

  it('按键组内常通：1.l↔1.r 同网络（05-§1.4 内部连通）', () => {
    const bus = new PinBus();
    bus.load(makeCircuit(), board, partDefs);
    bus.claimInput('btn1:1.l', 'up');
    bus.injectPin('btn1:1.l', 0);
    expect(bus.read('btn1:1.r')).toBe(0);
    // 组间（1.x 与 2.x）不合并：按下导通由注入语义模拟
    bus.claimInput('btn1:2.l', 'up');
    expect(bus.read('btn1:2.l')).toBe(1);
  });
});
