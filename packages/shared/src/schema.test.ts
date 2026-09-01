import { describe, it, expect } from 'vitest';
import {
  clientMsgSchema,
  serverMsgSchema,
  pingSchema,
  pongSchema,
  circuitDocSchema,
  inputEventSchema,
  partDefinitionSchema,
  workerMsgSchema,
  type ClientMsgType,
  type ServerMsgType,
} from './index';

/** 最小合法元件实例（板卡） */
const boardPart = {
  id: 'esp',
  type: 'board-esp32-devkit-c-v4',
  left: 0,
  top: 0,
  rotate: 0,
  attrs: {},
};

/** 最小合法 CircuitDoc（单板卡 + 单元件） */
const minimalCircuit = {
  formatVersion: 1,
  boardType: 'board-esp32-devkit-c-v4',
  parts: [boardPart],
  connections: [],
  serialMonitor: { baudrate: 115200 },
};

describe('clientMsgSchema（03-§2.5）', () => {
  it('accepts all five message types', () => {
    const msgs = [
      {
        type: 'attach',
        payload: {
          projectId: 'p1',
          circuit: minimalCircuit,
          firmwareId: 'b1',
          boardType: 'board-esp32-devkit-c-v4',
        },
      },
      { type: 'input.pin', payload: { partId: 'btn', pin: '1', level: 1 } },
      { type: 'input.analog', payload: { partId: 'pot', pin: 'SIG', value: 4095 } },
      { type: 'input.uart', payload: { bytes: [104, 105] } },
      { type: 'ctrl', payload: 'start' },
    ];
    for (const m of msgs) {
      expect(clientMsgSchema.safeParse(m).success, `should accept ${m.type}`).toBe(true);
    }
  });

  it('rejects invalid payloads', () => {
    expect(
      clientMsgSchema.safeParse({ type: 'input.pin', payload: { partId: 'b', pin: '1', level: 2 } })
        .success,
    ).toBe(false);
    expect(
      clientMsgSchema.safeParse({
        type: 'input.analog',
        payload: { partId: 'p', pin: 'SIG', value: 4096 },
      }).success,
    ).toBe(false);
    expect(
      clientMsgSchema.safeParse({ type: 'input.uart', payload: { bytes: [-1] } }).success,
    ).toBe(false);
    expect(clientMsgSchema.safeParse({ type: 'ctrl', payload: 'run' }).success).toBe(false);
    expect(clientMsgSchema.safeParse({ type: 'unknown.kind', payload: {} }).success).toBe(false);
  });

  it('rejects attach with invalid circuit', () => {
    const bad = {
      type: 'attach',
      payload: {
        projectId: 'p1',
        circuit: { ...minimalCircuit, formatVersion: 2 },
        firmwareId: 'b1',
        boardType: 'board-esp32-devkit-c-v4',
      },
    };
    expect(clientMsgSchema.safeParse(bad).success).toBe(false);
  });

  it('type alignment: ClientMsgType 枚举覆盖锁定（§2.5 快照要求）', () => {
    const expected: readonly ClientMsgType[] = [
      'attach',
      'input.pin',
      'input.analog',
      'input.uart',
      'ctrl',
      'ping',
    ];
    const actual = clientMsgSchema.options.map((o) => o.shape.type.value);
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it('accepts heartbeat ping（06-§7.1.1）', () => {
    expect(clientMsgSchema.safeParse({ type: 'ping', ts: 1_715_000_000_000 }).success).toBe(true);
    expect(clientMsgSchema.safeParse({ type: 'ping', ts: -1 }).success).toBe(false);
  });
});

describe('serverMsgSchema（03-§2.4）', () => {
  const msgs = [
    { type: 'state', payload: { status: 'running' } },
    { type: 'state', payload: { status: 'error', error: 'boom' } },
    { type: 'gpio.write', payload: { pin: 4, level: 1, seq: 0 } },
    { type: 'pwm.duty', payload: { pin: 4, duty: 512, freq: 1000 } },
    { type: 'uart.rx', payload: { bytes: [1, 2, 3] } },
    { type: 'i2c.txn', payload: { addr: 0x3c, dir: 'w', data: [0], seq: 1 } },
    { type: 'spi.txn', payload: { cs: 5, data: [0xff], seq: 2 } },
    { type: 'fb.update', payload: { partId: 'oled', rect: [0, 0, 8, 8], data: [0xaa], seq: 0 } },
    {
      type: 'neopixel.write',
      payload: { partId: 'np', pin: 4, pixels: [0, 255, 0, 255, 0, 0], seq: 1 },
    },
    { type: 'log', payload: { level: 'info', text: 'hello' } },
    { type: 'error.ack', payload: { code: 'WS_MSG_INVALID', message: 'bad' } },
    {
      type: 'build.progress',
      payload: { buildId: 'b1', phase: 'compiling', progress: 0.4, logLines: ['line1'] },
    },
    { type: 'pong', ts: 1_715_000_000_000 },
  ];

  it('accepts all message types', () => {
    for (const m of msgs) {
      expect(serverMsgSchema.safeParse(m).success, `should accept ${m.type}`).toBe(true);
    }
  });

  it('rejects unknown status and wrong shapes', () => {
    expect(
      serverMsgSchema.safeParse({ type: 'state', payload: { status: 'building' } }).success,
    ).toBe(false);
    expect(
      serverMsgSchema.safeParse({ type: 'gpio.write', payload: { pin: -1, level: 0 } }).success,
    ).toBe(false);
  });

  it('rejects invalid build.progress shapes', () => {
    expect(
      serverMsgSchema.safeParse({
        type: 'build.progress',
        payload: { buildId: 'b1', phase: 'installing', progress: 0.5 },
      }).success,
    ).toBe(false);
    expect(
      serverMsgSchema.safeParse({
        type: 'build.progress',
        payload: { buildId: 'b1', phase: 'failed', progress: 1.5 },
      }).success,
    ).toBe(false);
  });

  it('type alignment: ServerMsgType 枚举覆盖锁定', () => {
    const expected: readonly ServerMsgType[] = [
      'state',
      'gpio.write',
      'pwm.duty',
      'uart.rx',
      'i2c.txn',
      'spi.txn',
      'sensor.data',
      'fb.update',
      'neopixel.write',
      'log',
      'error.ack',
      'build.progress',
      'pong',
    ];
    const actual = serverMsgSchema.options.map((o) => o.shape.type.value);
    expect([...actual].sort()).toEqual([...expected].sort());
  });
});

describe('heartbeat schemas（06-§7.1.1 N20）', () => {
  it('accepts ping/pong with nonneg ts', () => {
    expect(pingSchema.safeParse({ type: 'ping', ts: 0 }).success).toBe(true);
    expect(pongSchema.safeParse({ type: 'pong', ts: Date.now() }).success).toBe(true);
  });
  it('rejects negative ts and unknown type', () => {
    expect(pingSchema.safeParse({ type: 'ping', ts: -1 }).success).toBe(false);
    expect(pongSchema.safeParse({ type: 'ping', ts: 1 }).success).toBe(false);
  });
});

describe('circuitDocSchema（03-§2.1）', () => {
  it('accepts minimal circuit and defaults hide', () => {
    const r = circuitDocSchema.parse(minimalCircuit);
    expect(r.parts[0]?.hide).toBeUndefined();
  });

  it('rejects bad rotate / bad wire color / bad formatVersion', () => {
    const badRotate = {
      ...minimalCircuit,
      parts: [{ ...boardPart, rotate: 45 }],
    };
    expect(circuitDocSchema.safeParse(badRotate).success).toBe(false);

    const badColor = {
      ...minimalCircuit,
      connections: [{ id: 'c1', source: 'esp:GPIO4', target: 'led:A', color: 'pink', path: [] }],
    };
    expect(circuitDocSchema.safeParse(badColor).success).toBe(false);

    expect(circuitDocSchema.safeParse({ ...minimalCircuit, formatVersion: 0 }).success).toBe(false);
  });

  it('accepts wire path segments v/h/*', () => {
    const doc = {
      ...minimalCircuit,
      connections: [
        {
          id: 'c1',
          source: 'esp:GPIO4',
          target: 'led:A',
          color: 'green',
          path: [
            { dir: 'v', len: 10 },
            { dir: 'h', len: 5 },
            { dir: '*', len: 0 },
          ],
        },
      ],
    };
    expect(circuitDocSchema.safeParse(doc).success).toBe(true);
  });
});

describe('inputEventSchema（03-§2.3 InputEvent）', () => {
  it('accepts four concrete variants', () => {
    expect(
      inputEventSchema.safeParse({ type: 'pin.level', partId: 'btn', pin: '1', level: 0 }).success,
    ).toBe(true);
    expect(
      inputEventSchema.safeParse({ type: 'analog.value', partId: 'pot', pin: 'SIG', value: 4095 })
        .success,
    ).toBe(true);
    expect(
      inputEventSchema.safeParse({ type: 'sensor.data', partId: 'dht', data: { temp: 25.5 } })
        .success,
    ).toBe(true);
    expect(
      inputEventSchema.safeParse({ type: 'uart.tx', bytes: new Uint8Array([1, 2]) }).success,
    ).toBe(true);
  });

  it('rejects out-of-range analog value', () => {
    expect(
      inputEventSchema.safeParse({ type: 'analog.value', partId: 'p', pin: 'SIG', value: -1 })
        .success,
    ).toBe(false);
  });
});

describe('partDefinitionSchema（03-§2.2）', () => {
  const led = {
    type: 'wokwi-led',
    name: 'LED',
    category: 'io',
    defVersion: 1,
    pins: [{ name: 'A', role: 'signal.in', x: 10, y: 0 }],
    attrs: [
      {
        key: 'color',
        type: 'enum',
        label: '颜色',
        default: 'red',
        options: [{ value: 'red', label: '红' }],
      },
    ],
    renderer: { asset: 'led.svg', width: 24, height: 24 },
    simulator: { listens: ['gpio.write', 'pwm.duty'], behavior: '亮灭随电平/PWM' },
  };

  it('accepts a valid LED definition', () => {
    expect(partDefinitionSchema.safeParse(led).success).toBe(true);
  });

  it('rejects unknown pin role and unknown listens event', () => {
    expect(
      partDefinitionSchema.safeParse({
        ...led,
        pins: [{ name: 'A', role: 'signal.up', x: 0, y: 0 }],
      }).success,
    ).toBe(false);
    expect(
      partDefinitionSchema.safeParse({
        ...led,
        simulator: { ...led.simulator, listens: ['gpio.toggle'] },
      }).success,
    ).toBe(false);
  });

  it('M8: accepts i2c-device with registers (BH1750-like)', () => {
    const bh1750 = {
      type: 'wokwi-bh1750',
      name: 'BH1750',
      category: 'sensor',
      defVersion: 1,
      pins: [
        { name: 'SDA', role: 'i2c.sda', x: 0, y: 0 },
        { name: 'SCL', role: 'i2c.scl', x: 10, y: 0 },
        { name: 'VCC', role: 'power', x: 0, y: 10 },
        { name: 'GND', role: 'gnd', x: 10, y: 10 },
      ],
      attrs: [],
      renderer: { asset: 'bh1750.svg', width: 32, height: 32 },
      simulator: {
        listens: ['i2c.txn'],
        produces: ['sensor.data'],
        behavior: 'i2c-device',
        device: {
          kind: 'i2c-device',
          address: 0x23,
          registers: [{ addr: 0x10, size: 2, decode: 'lux' }],
        },
      },
    };
    expect(partDefinitionSchema.safeParse(bh1750).success).toBe(true);
  });

  it('M8: accepts spi-device with csGpio', () => {
    const spiDev = {
      type: 'wokwi-spi-sensor',
      name: 'SPI Sensor',
      category: 'sensor',
      defVersion: 1,
      pins: [
        { name: 'CS', role: 'spi.cs', x: 0, y: 0 },
        { name: 'SCK', role: 'spi.sck', x: 10, y: 0 },
        { name: 'MOSI', role: 'spi.mosi', x: 20, y: 0 },
        { name: 'MISO', role: 'spi.miso', x: 30, y: 0 },
      ],
      attrs: [],
      renderer: { asset: 'spi.svg', width: 32, height: 32 },
      simulator: {
        listens: ['spi.txn'],
        behavior: 'spi-device',
        device: {
          kind: 'spi-device',
          csGpio: 5,
          registers: [{ addr: 0x9f, size: 4, decode: 'raw' }],
        },
      },
    };
    expect(partDefinitionSchema.safeParse(spiDev).success).toBe(true);
  });

  it('M8: rejects i2c-device with address > 0x7f', () => {
    const bad = {
      ...led,
      simulator: {
        listens: ['i2c.txn'],
        behavior: 'i2c-device',
        device: { kind: 'i2c-device', address: 0x80, registers: [] },
      },
    };
    expect(partDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it('M8: rejects device with unknown kind (discriminated union)', () => {
    const bad = {
      ...led,
      simulator: {
        listens: ['i2c.txn'],
        behavior: 'i2c-device',
        device: { kind: '1wire-device', address: 0x10, registers: [] },
      },
    };
    expect(partDefinitionSchema.safeParse(bad).success).toBe(false);
  });
});

describe('workerMsgSchema（03-§2.6）', () => {
  it('accepts load with sources and binary firmware', () => {
    expect(
      workerMsgSchema.safeParse({
        type: 'load',
        payload: {
          circuit: minimalCircuit,
          fw: { kind: 'sources', files: [{ path: 'main.py', content: 'print(1)' }] },
        },
      }).success,
    ).toBe(true);
    expect(
      workerMsgSchema.safeParse({
        type: 'load',
        payload: { circuit: minimalCircuit, fw: { kind: 'binary', flashImg: new Uint8Array([1]) } },
      }).success,
    ).toBe(true);
  });

  it('accepts control messages and rejects unknown type', () => {
    expect(workerMsgSchema.safeParse({ type: 'start', payload: { speed: 2 } }).success).toBe(true);
    expect(workerMsgSchema.safeParse({ type: 'dispose' }).success).toBe(true);
    expect(workerMsgSchema.safeParse({ type: 'start', payload: { speed: 3 } }).success).toBe(false);
    expect(workerMsgSchema.safeParse({ type: 'poll' }).success).toBe(false);
  });
});
