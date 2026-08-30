import { describe, it, expect, beforeEach } from 'vitest';
import type { CircuitDoc, EngineEventMap, EngineEventType, PinRef } from '@esp32-sim/shared';
import type { SimulationEngine } from '@esp32-sim/shared';
import { useCircuitStore } from '../circuit/circuitStore';
import { simSession, useSimStore } from '../stores/sim';
import { pressButton, releaseButton, toggleSwitch } from './part-input';

/**
 * L1（02-§4 M5 测试项）：按键/开关输入注入（05-§1.4 / §1.7，双引擎入口）
 * 信号脚自动选择（BFS 可达板卡 GPIO）+ 电平取对侧网络电源语义 + release 语义。
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
      { id: 'btn1', type: 'wokwi-pushbutton', left: 300, top: 220, rotate: 0, attrs: {} },
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

/** SimulationEngine stub：仅收集 input 事件（attach 需要 on/dispose 等空实现） */
function makeEngineStub() {
  const inputs: Array<Extract<EngineEventMap[keyof EngineEventMap], never> | unknown> = [];
  const engine = {
    kind: 'micropython-wasm' as const,
    load: async () => {},
    start: () => {},
    pause: () => {},
    reset: async () => {},
    dispose: () => {},
    input: (ev: unknown) => inputs.push(ev),
    on: (_type: EngineEventType, _cb: (p: never) => void) => () => {},
  } satisfies SimulationEngine & { input: (ev: unknown) => void };
  return { engine, inputs };
}

function setDoc(connections: ConnInput[]): void {
  useCircuitStore.setState({ doc: makeCircuit(connections) });
}

beforeEach(() => {
  simSession.dispose();
  useSimStore.setState({ status: 'running' });
});

describe('按键注入（pressButton / releaseButton，05-§1.4）', () => {
  it('典型接法（GPIO4→1.l、2.l→GND）：按下注入 1.l 电平 0，松开 release', () => {
    setDoc([
      { id: 'w1', source: 'esp:GPIO4', target: 'btn1:1.l', color: 'green', path: [] },
      { id: 'w2', source: 'btn1:2.l', target: 'esp:GND.1', color: 'black', path: [] },
    ]);
    const { engine, inputs } = makeEngineStub();
    simSession.attach(engine);

    pressButton('btn1');
    expect(inputs).toEqual([{ type: 'pin.level', partId: 'btn1', pin: '1.l', level: 0 }]);

    releaseButton('btn1');
    expect(inputs[1]).toEqual({
      type: 'pin.level',
      partId: 'btn1',
      pin: '1.l',
      level: 0,
      release: true,
    });
  });

  it('反接（GPIO4→2.l、1.l→GND）：自动选 2.l 为信号脚', () => {
    setDoc([
      { id: 'w1', source: 'esp:GPIO4', target: 'btn1:2.l', color: 'green', path: [] },
      { id: 'w2', source: 'btn1:1.l', target: 'esp:GND.1', color: 'black', path: [] },
    ]);
    const { engine, inputs } = makeEngineStub();
    simSession.attach(engine);

    pressButton('btn1');
    expect(inputs).toEqual([{ type: 'pin.level', partId: 'btn1', pin: '2.l', level: 0 }]);
  });

  it('对脚接 3V3（高电平按下）：注入电平 1', () => {
    setDoc([
      { id: 'w1', source: 'esp:GPIO4', target: 'btn1:1.l', color: 'green', path: [] },
      { id: 'w2', source: 'btn1:2.l', target: 'esp:3V3', color: 'red', path: [] },
    ]);
    const { engine, inputs } = makeEngineStub();
    simSession.attach(engine);

    pressButton('btn1');
    expect(inputs).toEqual([{ type: 'pin.level', partId: 'btn1', pin: '1.l', level: 1 }]);
  });

  it('非运行状态不注入', () => {
    useSimStore.setState({ status: 'idle' });
    setDoc([{ id: 'w1', source: 'esp:GPIO4', target: 'btn1:1.l', color: 'green', path: [] }]);
    const { engine, inputs } = makeEngineStub();
    simSession.attach(engine);

    pressButton('btn1');
    releaseButton('btn1');
    expect(inputs).toEqual([]);
  });
});

describe('滑动开关注入（toggleSwitch，05-§1.7）', () => {
  it('公共端 2 接 GPIO4、1 接 GND：position 1 → 注入 0；position 2 → release', () => {
    setDoc([
      { id: 'w1', source: 'esp:GPIO4', target: 'sw1:2', color: 'green', path: [] },
      { id: 'w2', source: 'sw1:1', target: 'esp:GND.1', color: 'black', path: [] },
    ]);
    const { engine, inputs } = makeEngineStub();
    simSession.attach(engine);

    toggleSwitch('sw1', '1');
    expect(inputs[0]).toEqual({ type: 'pin.level', partId: 'sw1', pin: '2', level: 0 });

    toggleSwitch('sw1', '2'); // 2↔3 导通：信号脚 2 与 3 通、1 断开 → 释放
    expect(inputs[1]).toEqual({
      type: 'pin.level',
      partId: 'sw1',
      pin: '2',
      level: 0,
      release: true,
    });
  });

  it('信号脚在 3（GPIO4→sw.3、2 接 GND）：position 2 → 注入；position 1 → release', () => {
    setDoc([
      { id: 'w1', source: 'esp:GPIO4', target: 'sw1:3', color: 'green', path: [] },
      { id: 'w2', source: 'sw1:2', target: 'esp:GND.1', color: 'black', path: [] },
    ]);
    const { engine, inputs } = makeEngineStub();
    simSession.attach(engine);

    toggleSwitch('sw1', '2');
    expect(inputs[0]).toEqual({ type: 'pin.level', partId: 'sw1', pin: '3', level: 0 });

    toggleSwitch('sw1', '1');
    expect(inputs[1]).toMatchObject({ release: true });
  });

  it('对脚接 3V3：导通时注入电平 1', () => {
    setDoc([
      { id: 'w1', source: 'esp:GPIO4', target: 'sw1:2', color: 'green', path: [] },
      { id: 'w2', source: 'sw1:3', target: 'esp:3V3', color: 'red', path: [] },
    ]);
    const { engine, inputs } = makeEngineStub();
    simSession.attach(engine);

    toggleSwitch('sw1', '2');
    expect(inputs[0]).toEqual({ type: 'pin.level', partId: 'sw1', pin: '2', level: 1 });
  });
});
