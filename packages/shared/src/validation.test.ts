import { describe, expect, it } from 'vitest';
import type { CircuitDoc, PinRef } from './circuit';
import { parsePinRef, parseDiagram, serializeDiagram, validateCircuitDoc } from './validation';
import type { ValidationContext } from './validation';

/** 测试用最小 catalog：board + led 两种类型 */
const ctx: ValidationContext = {
  partTypes: new Set(['board-esp32-devkit-c-v4', 'wokwi-led']),
  pinNames: (type) => {
    if (type === 'board-esp32-devkit-c-v4') return new Set(['GPIO4', 'GND.1', '3V3']);
    if (type === 'wokwi-led') return new Set(['A', 'C']);
    return undefined;
  },
};

function baseDoc(): CircuitDoc {
  return {
    formatVersion: 1,
    boardType: 'board-esp32-devkit-c-v4',
    parts: [
      {
        id: 'esp',
        type: 'board-esp32-devkit-c-v4',
        left: 0,
        top: 0,
        rotate: 0,
        attrs: {},
      },
      { id: 'led1', type: 'wokwi-led', left: 300, top: 100, rotate: 0, attrs: { color: 'red' } },
    ],
    connections: [
      { id: 'w1', source: 'esp:GPIO4', target: 'led1:A', color: 'green', path: [] },
      {
        id: 'w2',
        source: 'led1:C',
        target: 'esp:GND.1',
        color: 'black',
        path: [{ dir: 'v', len: 40 }],
      },
    ],
    serialMonitor: { baudrate: 115200 },
  };
}

describe('parsePinRef', () => {
  it.each([
    ['esp:GPIO4', { partId: 'esp', pin: 'GPIO4' }],
    ['p_1:GND.1', { partId: 'p_1', pin: 'GND.1' }],
  ])('解析合法 PinRef %s', (ref, expected) => {
    expect(parsePinRef(ref)).toEqual(expected);
  });

  it.each(['no-colon', ':GPIO4', 'esp:'])('拒绝非法 PinRef %s', (ref) => {
    expect(parsePinRef(ref)).toBeNull();
  });
});

describe('validateCircuitDoc', () => {
  it('合法文档通过', () => {
    expect(validateCircuitDoc(baseDoc(), ctx)).toEqual({ ok: true, errors: [] });
  });

  it('BAD_JSON：结构不合法（缺 serialMonitor）', () => {
    const doc = baseDoc() as unknown as Record<string, unknown>;
    delete doc.serialMonitor;
    const v = validateCircuitDoc(doc, ctx);
    expect(v.ok).toBe(false);
    expect(v.errors[0]?.code).toBe('BAD_JSON');
  });

  it('BAD_JSON：formatVersion 非 1', () => {
    const doc = { ...baseDoc(), formatVersion: 2 };
    const v = validateCircuitDoc(doc, ctx);
    expect(v.errors[0]?.code).toBe('BAD_JSON');
    expect(v.errors[0]?.message).toContain('formatVersion');
  });

  it('DUP_PART_ID：重复元件 ID', () => {
    const doc = baseDoc();
    doc.parts[1]!.id = 'esp';
    const v = validateCircuitDoc(doc, ctx);
    expect(v.errors.some((e) => e.code === 'DUP_PART_ID' && e.message.includes('esp'))).toBe(true);
  });

  it('UNKNOWN_TYPE：未收录类型', () => {
    const doc = baseDoc();
    doc.parts[1]!.type = 'wokwi-motor';
    const v = validateCircuitDoc(doc, ctx);
    expect(
      v.errors.some((e) => e.code === 'UNKNOWN_TYPE' && e.message.includes('wokwi-motor')),
    ).toBe(true);
  });

  it('BAD_PINREF：指向不存在的元件', () => {
    const doc = baseDoc();
    doc.connections[0]!.source = 'ghost:GPIO4';
    const v = validateCircuitDoc(doc, ctx);
    expect(v.errors.some((e) => e.code === 'BAD_PINREF' && e.message.includes('ghost'))).toBe(true);
  });

  it('BAD_PINREF：引脚名不存在', () => {
    const doc = baseDoc();
    doc.connections[0]!.target = 'led1:X';
    const v = validateCircuitDoc(doc, ctx);
    expect(v.errors.some((e) => e.code === 'BAD_PINREF' && e.message.includes('X'))).toBe(true);
  });

  it('BAD_PINREF：PinRef 缺冒号', () => {
    const doc = baseDoc();
    // 运行时故意注入非法格式（绕过模板字面量类型检查）
    doc.connections[0]!.source = 'espGPIO4' as unknown as PinRef;
    const v = validateCircuitDoc(doc, ctx);
    expect(v.errors.some((e) => e.code === 'BAD_PINREF')).toBe(true);
  });

  it('OVER_LIMIT：元件超 120 / 连线超 300', () => {
    const doc = baseDoc();
    doc.parts = Array.from({ length: 121 }, (_, i) => ({
      id: `p${i}`,
      type: 'wokwi-led',
      left: 0,
      top: 0,
      rotate: 0,
      attrs: {},
    }));
    doc.connections = Array.from({ length: 301 }, (_, i) => ({
      id: `w${i}`,
      source: 'esp:GPIO4',
      target: 'esp:GND.1',
      color: 'green',
      path: [],
    }));
    const v = validateCircuitDoc(doc, ctx);
    expect(v.errors.filter((e) => e.code === 'OVER_LIMIT')).toHaveLength(2);
  });

  it('自定义上限生效', () => {
    const doc = baseDoc();
    doc.connections = Array.from({ length: 3 }, (_, i) => ({
      id: `w${i}`,
      source: 'esp:GPIO4',
      target: 'esp:GND.1',
      color: 'green',
      path: [],
    }));
    const v = validateCircuitDoc(doc, ctx);
    expect(v.ok).toBe(true);
    const v2 = validateCircuitDoc(doc, { ...ctx, limits: { maxParts: 120, maxConnections: 2 } });
    expect(v2.errors.some((e) => e.code === 'OVER_LIMIT')).toBe(true);
  });

  it('多错误不短路：同时报 DUP_PART_ID + BAD_PINREF', () => {
    const doc = baseDoc();
    doc.parts[1]!.id = 'esp';
    doc.connections[0]!.source = 'esp:GPIO4';
    const v = validateCircuitDoc(doc, ctx);
    const codes = v.errors.map((e) => e.code);
    expect(codes).toContain('DUP_PART_ID');
    expect(codes).toContain('BAD_PINREF');
  });

  // M8：I2C/SPI 总线冲突
  describe('M8 总线地址冲突检测', () => {
    const busCtx: ValidationContext = {
      partTypes: new Set([
        'board-esp32-devkit-c-v4',
        'wokwi-led',
        'wokwi-bh1750',
        'wokwi-mpu6050',
        'wokwi-w25q32',
      ]),
      pinNames: (type) => {
        if (type === 'board-esp32-devkit-c-v4')
          return new Set(['GPIO4', 'GND.1', '3V3', 'GPIO21', 'GPIO22']);
        if (type === 'wokwi-led') return new Set(['A', 'C']);
        if (type === 'wokwi-bh1750') return new Set(['VCC', 'GND', 'SDA', 'SCL']);
        if (type === 'wokwi-mpu6050') return new Set(['VCC', 'GND', 'SDA', 'SCL', 'INT']);
        if (type === 'wokwi-w25q32') return new Set(['VCC', 'GND', 'CS', 'SCK', 'MOSI', 'MISO']);
        return undefined;
      },
      deviceSpec: (type) => {
        if (type === 'wokwi-bh1750') return { kind: 'i2c-device', address: 0x23, registers: [] };
        if (type === 'wokwi-mpu6050') return { kind: 'i2c-device', address: 0x68, registers: [] };
        if (type === 'wokwi-w25q32') return { kind: 'spi-device', csGpio: 5 };
        return null;
      },
    };

    it('I2C_ADDR_CONFLICT：同地址两 BH1750 报冲突', () => {
      const doc = baseDoc();
      doc.connections = [];
      doc.parts.push(
        { id: 'bh1', type: 'wokwi-bh1750', left: 300, top: 200, rotate: 0, attrs: {} },
        { id: 'bh2', type: 'wokwi-bh1750', left: 400, top: 200, rotate: 0, attrs: {} },
      );
      const v = validateCircuitDoc(doc, busCtx);
      expect(v.ok).toBe(false);
      const codes = v.errors.map((e) => e.code);
      expect(codes).toContain('I2C_ADDR_CONFLICT');
      const err = v.errors.find((e) => e.code === 'I2C_ADDR_CONFLICT');
      expect(err?.message).toContain('0x23');
    });

    it('I2C_ADDR_CONFLICT：BH1750(0x23) + MPU6050(0x68) 不报冲突', () => {
      const doc = baseDoc();
      doc.connections = [];
      doc.parts.push(
        { id: 'bh', type: 'wokwi-bh1750', left: 300, top: 200, rotate: 0, attrs: {} },
        { id: 'mp', type: 'wokwi-mpu6050', left: 400, top: 200, rotate: 0, attrs: {} },
      );
      const v = validateCircuitDoc(doc, busCtx);
      const codes = v.errors.map((e) => e.code);
      expect(codes).not.toContain('I2C_ADDR_CONFLICT');
    });

    it('SPI_CS_CONFLICT：两 W25Q32 报 CS 冲突', () => {
      const doc = baseDoc();
      doc.connections = [];
      doc.parts.push(
        { id: 'w1', type: 'wokwi-w25q32', left: 300, top: 200, rotate: 0, attrs: {} },
        { id: 'w2', type: 'wokwi-w25q32', left: 400, top: 200, rotate: 0, attrs: {} },
      );
      const v = validateCircuitDoc(doc, busCtx);
      expect(v.ok).toBe(false);
      const codes = v.errors.map((e) => e.code);
      expect(codes).toContain('SPI_CS_CONFLICT');
    });

    it('无 deviceSpec 的 ctx 跳过总线扫描（向后兼容）', () => {
      const v = validateCircuitDoc(baseDoc(), ctx);
      const codes = v.errors.map((e) => e.code);
      expect(codes).not.toContain('I2C_ADDR_CONFLICT');
      expect(codes).not.toContain('SPI_CS_CONFLICT');
    });
  });
});

describe('diagram serialize/parse 往返', () => {
  it('serialize → parse 得到等价文档', () => {
    const doc = baseDoc();
    const text = serializeDiagram(doc);
    const r = parseDiagram(text, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc).toEqual(doc);
  });

  it('parse 拒绝非法 JSON 且报 BAD_JSON', () => {
    const r = parseDiagram('{ not json', ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.validation.errors[0]?.code).toBe('BAD_JSON');
  });

  it('parse 携带 ctx 时同时做语义校验', () => {
    const doc = baseDoc();
    doc.connections[0]!.target = 'led1:X';
    const r = parseDiagram(serializeDiagram(doc), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.validation.errors[0]?.code).toBe('BAD_PINREF');
  });

  it('键序稳定：同文档两次 serialize 输出一致', () => {
    const doc = baseDoc();
    expect(serializeDiagram(doc)).toBe(serializeDiagram(doc));
  });
});
