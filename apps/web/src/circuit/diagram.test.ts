// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CircuitDoc } from '@esp32-sim/shared';
import { validateCircuitDoc } from '@esp32-sim/shared';
import { applyDiagramText, buildDiagramText, importDiagram, WOKWI_BLINK_SAMPLE } from './diagram';
import { createDefaultDoc, useCircuitStore } from './circuitStore';

describe('importDiagram（Wokwi 格式规范化）', () => {
  it('Wokwi blink 示例导入成功，类型/引脚全部收录', () => {
    const r = importDiagram(JSON.parse(WOKWI_BLINK_SAMPLE));
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.doc?.parts.map((p) => p.id)).toEqual(['esp', 'led1', 'r1']);
    expect(r.doc?.connections).toHaveLength(3);
    expect(r.doc?.boardType).toBe('board-esp32-devkit-c-v4');
  });

  it('Wokwi path 字符串（"v0"/"h30"）→ WireSegment', () => {
    const raw = JSON.parse(WOKWI_BLINK_SAMPLE);
    raw.connections = [['esp:GPIO4', 'r1:1', 'green', ['v0', 'h30', '*']]];
    const r2 = importDiagram(raw);
    expect(r2.doc?.connections[0]?.path).toEqual([
      { dir: 'v', len: 0 },
      { dir: 'h', len: 30 },
    ]);
  });

  it('省略 rotate 的 Wokwi 元件补 0；attrs 保留（含字符串型数值）', () => {
    const r = importDiagram(JSON.parse(WOKWI_BLINK_SAMPLE));
    const r1 = r.doc?.parts.find((p) => p.id === 'r1');
    expect(r1?.rotate).toBe(90);
    expect(r1?.attrs['value']).toBe('1000');
    const esp = r.doc?.parts.find((p) => p.id === 'esp');
    expect(esp?.rotate).toBe(0);
  });

  it('未收录元件进 skipped，其连线一并剔除', () => {
    const raw = JSON.parse(WOKWI_BLINK_SAMPLE);
    raw.parts.push({ type: 'wokwi-motor', id: 'm1', top: 100, left: 100, attrs: {} });
    raw.connections.push(['m1:1', 'esp:GND.1', 'black', ['v0']]);
    const r = importDiagram(raw);
    expect(r.skipped).toEqual(['wokwi-motor']);
    expect(r.doc?.parts.map((p) => p.id)).not.toContain('m1');
    expect(
      r.doc?.connections.every((c) => !c.source.startsWith('m1') && !c.target.startsWith('m1')),
    ).toBe(true);
  });

  it('非对象根节点报错', () => {
    expect(importDiagram('x').errors).toHaveLength(1);
    expect(importDiagram(null).errors).toHaveLength(1);
  });
});

describe('applyDiagramText / buildDiagramText（双向同步）', () => {
  it('本项目导出文本：apply → 往返一致', () => {
    const doc = createDefaultDoc();
    doc.parts.push({ id: 'led1', type: 'wokwi-led', left: 400, top: 200, rotate: 0, attrs: {} });
    doc.connections.push({
      id: 'w1',
      source: 'esp:GPIO4',
      target: 'led1:A',
      color: 'green',
      path: [{ dir: 'v', len: 20 }],
    });
    const text = buildDiagramText(doc);
    const r = applyDiagramText(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.parts).toHaveLength(2);
      expect(r.doc.connections[0]?.source).toBe('esp:GPIO4');
      // 再序列化一次仍稳定
      expect(buildDiagramText(r.doc)).toBe(buildDiagramText(structuredClone(r.doc) as CircuitDoc));
    }
  });

  it('Wokwi blink 文本 apply 成功且通过语义校验', () => {
    const r = applyDiagramText(WOKWI_BLINK_SAMPLE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const v = validateCircuitDoc(r.doc, {
        partTypes: new Set(['board-esp32-devkit-c-v4', 'wokwi-led', 'wokwi-resistor']),
        pinNames: (t) =>
          t === 'wokwi-led'
            ? new Set(['A', 'C'])
            : t === 'wokwi-resistor'
              ? new Set(['1', '2'])
              : new Set(['GPIO4', 'GND.1']),
      });
      expect(v.ok).toBe(true);
    }
  });

  it('非法 JSON：报错且不产生文档', () => {
    const r = applyDiagramText('{ bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('JSON');
  });

  it('结构合法但语义非法（未知引脚）：报错不产生文档', () => {
    const doc = createDefaultDoc();
    doc.connections.push({
      id: 'w1',
      source: 'esp:GPIO999',
      target: 'esp:GND.1',
      color: 'green',
      path: [],
    });
    const r = applyDiagramText(buildDiagramText(doc));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('GPIO999');
  });
});

describe('store.replaceDoc 集成（JSON → 画布）', () => {
  it('blink 示例替换成功，画布文档可再导出', () => {
    useCircuitStore.getState().__reset();
    const r = applyDiagramText(WOKWI_BLINK_SAMPLE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(useCircuitStore.getState().replaceDoc(r.doc)).toBe(true);
      const text = buildDiagramText(useCircuitStore.getState().doc);
      expect(text).toContain('"wokwi-led"');
      expect(text).toContain('"esp:GPIO4"');
    }
  });
});
