// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '@esp32-sim/shared';
import { BOARD_TYPE, createDefaultDoc, useCircuitStore } from './circuitStore';

const s = () => useCircuitStore.getState();

beforeEach(() => {
  useCircuitStore.getState().__reset();
});

describe('初始文档', () => {
  it('parts[0] 为板卡且 boardType 一致（03-§2.1）', () => {
    const { doc } = s();
    expect(doc.parts[0]?.type).toBe(BOARD_TYPE);
    expect(doc.boardType).toBe(BOARD_TYPE);
    expect(doc.parts[0]?.id).toBe('esp');
    expect(doc.connections).toEqual([]);
  });
});

describe('addPart', () => {
  it('新增元件：20px 吸附 + 选中 + dirty', () => {
    const id = s().addPart('wokwi-led', { x: 345, y: 277 });
    expect(id).not.toBeNull();
    const { doc, dirty, selectedPartIds } = s();
    const p = doc.parts.find((x) => x.id === id);
    expect(p?.left).toBe(340);
    expect(p?.top).toBe(280);
    expect(dirty).toBe(true);
    expect(selectedPartIds).toEqual([id]);
  });

  it('第二块板卡被拒绝', () => {
    const r = s().addPart('board-esp32-devkit-c-v4', { x: 400, y: 400 });
    expect(r).toBeNull();
    expect(s().error).toContain('板卡');
    expect(s().doc.parts).toHaveLength(1);
  });

  it('超过 120 上限被拒绝', () => {
    for (let i = 0; i < 119; i++) s().addPart('wokwi-led', { x: 400, y: 100 + i * 2 });
    expect(s().doc.parts).toHaveLength(120);
    const r = s().addPart('wokwi-led', { x: 0, y: 0 });
    expect(r).toBeNull();
    expect(s().error).toContain('上限');
  });

  it('未知类型会被 addConnection 前放行，但 replaceDoc/校验兜底（此处仅记录行为）', () => {
    // addPart 不查 catalog（拖拽入口只来自元件库白名单），保持宽松
    const id = s().addPart('wokwi-motor', { x: 400, y: 200 });
    expect(id).not.toBeNull();
  });
});

describe('movePart / rotatePart / updateAttr', () => {
  it('movePart 吸附到网格', () => {
    const id = s().addPart('wokwi-led', { x: 400, y: 200 });
    s().movePart(id!, { x: 333, y: 211 });
    const p = s().doc.parts.find((x) => x.id === id);
    expect([p?.left, p?.top]).toEqual([340, 220]);
  });

  it('rotatePart 循环 0→90→180→270→0', () => {
    const id = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    expect(s().doc.parts.find((x) => x.id === id)?.rotate).toBe(0);
    s().rotatePart(id);
    expect(s().doc.parts.find((x) => x.id === id)?.rotate).toBe(90);
    s().rotatePart(id);
    s().rotatePart(id);
    expect(s().doc.parts.find((x) => x.id === id)?.rotate).toBe(270);
    s().rotatePart(id);
    expect(s().doc.parts.find((x) => x.id === id)?.rotate).toBe(0);
  });

  it('updateAttr 写入属性并标脏', () => {
    const id = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    s().markSaved();
    s().updateAttr(id, 'color', 'blue');
    expect(s().doc.parts.find((x) => x.id === id)?.attrs['color']).toBe('blue');
    expect(s().dirty).toBe(true);
  });
});

describe('连线', () => {
  it('addConnection：8 色轮转首两根绿/红，路径默认自动（空数组）', () => {
    const led = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    const w1 = s().addConnection('esp:GPIO4', `${led}:A`);
    s().addConnection(`${led}:C`, 'esp:GND.1');
    expect(w1).not.toBeNull();
    const conns = s().doc.connections;
    expect(conns[0]?.color).toBe('green');
    expect(conns[0]?.path).toEqual([]);
    expect(conns[1]?.color).toBe('red');
  });

  it('同一引脚自环被拒绝', () => {
    const r = s().addConnection('esp:GPIO4', 'esp:GPIO4');
    expect(r).toBeNull();
    expect(s().error).toContain('同一引脚');
  });

  it('未知引脚被拒绝（BAD_PINREF 兜底）', () => {
    const led = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    const r = s().addConnection(`${led}:X`, 'esp:GND.1');
    expect(r).toBeNull();
    expect(s().error).toContain('引脚');
  });

  it('超过 300 上限被拒绝', () => {
    const led = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    const store = useCircuitStore;
    const doc = store.getState().doc;
    const bulk: Connection[] = Array.from({ length: 300 }, (_, i) => ({
      id: `bulk${i}`,
      source: 'esp:GPIO4',
      target: `${led}:A`,
      color: 'blue' as const,
      path: [],
    }));
    store.setState({ doc: { ...doc, connections: bulk } });
    const r = s().addConnection(`${led}:C`, 'esp:GND.1');
    expect(r).toBeNull();
    expect(s().error).toContain('上限');
  });

  it('updateWirePath / removeConnection', () => {
    const led = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    const w = s().addConnection('esp:GPIO4', `${led}:A`)!;
    s().updateWirePath(w, [
      { dir: 'v', len: 40 },
      { dir: 'h', len: 60 },
    ]);
    expect(s().doc.connections[0]?.path).toEqual([
      { dir: 'v', len: 40 },
      { dir: 'h', len: 60 },
    ]);
    s().removeConnection(w);
    expect(s().doc.connections).toHaveLength(0);
    expect(s().selectedConnectionId).toBeUndefined();
  });

  it('setConnectionColor：合法色更新，非法色拒绝', () => {
    const led = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    const w = s().addConnection('esp:GPIO4', `${led}:A`)!;
    s().setConnectionColor(w, 'purple');
    expect(s().doc.connections[0]?.color).toBe('purple');
    expect(s().dirty).toBe(true);
    // @ts-expect-error 故意传非法颜色字符串验证运行时兜底
    s().setConnectionColor(w, 'hotpink');
    expect(s().doc.connections[0]?.color).toBe('purple');
    expect(s().error).toContain('未知线色');
  });
});

describe('removePart 级联', () => {
  it('删除元件同时删除相关连线', () => {
    const led = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    s().addConnection('esp:GPIO4', `${led}:A`);
    s().addConnection('esp:GND.1', `${led}:C`);
    s().addConnection('esp:GPIO4', 'esp:GND.1');
    s().removePart(led);
    expect(s().doc.parts).toHaveLength(1);
    expect(s().doc.connections).toHaveLength(1);
    expect(s().doc.connections[0]?.target).toBe('esp:GND.1');
  });
});

describe('replaceDoc（JSON 导入 / 打开工程）', () => {
  it('合法文档替换成功，默认标脏', () => {
    const next = createDefaultDoc();
    next.parts.push({
      id: 'led1',
      type: 'wokwi-led',
      left: 400,
      top: 200,
      rotate: 0,
      attrs: {},
    });
    expect(s().replaceDoc(next)).toBe(true);
    expect(s().doc.parts).toHaveLength(2);
    expect(s().dirty).toBe(true);
  });

  it('markClean 选项用于打开工程场景', () => {
    expect(s().replaceDoc(createDefaultDoc(), { markClean: true })).toBe(true);
    expect(s().dirty).toBe(false);
  });

  it('非法文档被拒绝且现有 doc 不变', () => {
    const before = s().doc;
    const bad = createDefaultDoc();
    (bad.parts[0] as { id: string }).id = 'ghost';
    bad.connections.push({
      id: 'w1',
      source: 'ghost:GPIO4',
      target: 'esp:GND.1',
      color: 'green',
      path: [],
    });
    expect(s().replaceDoc(bad)).toBe(false);
    expect(s().doc).toBe(before);
    expect(s().error).toContain('不存在');
  });
});

describe('选择状态', () => {
  it('selectPart 单选 / additive 多选 / 清除', () => {
    const a = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    const b = s().addPart('wokwi-resistor', { x: 440, y: 260 })!;
    s().selectPart(a);
    expect(s().selectedPartIds).toEqual([a]);
    s().selectPart(b, true);
    expect(s().selectedPartIds).toEqual([a, b]);
    s().selectPart(b, true); // toggle 移除
    expect(s().selectedPartIds).toEqual([a]);
    s().clearSelection();
    expect(s().selectedPartIds).toEqual([]);
  });

  it('连线与元件选择互斥', () => {
    const led = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    const w = s().addConnection('esp:GPIO4', `${led}:A`)!;
    s().selectPart(led);
    s().selectConnection(w);
    expect(s().selectedConnectionId).toBe(w);
    expect(s().selectedPartIds).toEqual([]);
    s().selectPart(led);
    expect(s().selectedConnectionId).toBeUndefined();
  });
});

describe('dirty / markSaved', () => {
  it('markSaved 重置脏标记', () => {
    s().addPart('wokwi-led', { x: 400, y: 200 });
    expect(s().dirty).toBe(true);
    s().markSaved();
    expect(s().dirty).toBe(false);
  });
});
