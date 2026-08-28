import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import InspectorPanel from './InspectorPanel';
import { createDefaultDoc, useCircuitStore } from '../circuit/circuitStore';
import { p1ValidationContext, P1_CATALOG } from '../circuit/catalog-data';
import type { PartDefinition } from '@esp32-sim/shared';

/**
 * Inspector L2（02-M2 验收）：AttrDef 五控件映射、位置/旋转、
 * 连线色板/锚点列表/自动布线/删除、板卡无删除按钮、多选批量操作。
 */

const s = () => useCircuitStore.getState();

beforeEach(() => {
  useCircuitStore.getState().__reset();
});

afterEach(() => {
  cleanup();
});

describe('元件属性', () => {
  it('单选 LED 渲染 enum/text 控件并反映当前值', () => {
    const id = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    render(<InspectorPanel />);
    expect(screen.getByText('LED')).toBeTruthy();
    const select = screen.getByTestId('attr-color') as HTMLSelectElement;
    expect(select.value).toBe('red'); // enum 默认（attrs 未设时取 default）
    expect((screen.getByTestId('attr-label') as HTMLInputElement).value).toBe('');
    // 切换 enum → updateAttr
    fireEvent.change(select, { target: { value: 'green' } });
    expect(s().doc.parts.find((p) => p.id === id)?.attrs['color']).toBe('green');
    // 文本属性
    fireEvent.change(screen.getByTestId('attr-label'), { target: { value: '电源灯' } });
    expect(s().doc.parts.find((p) => p.id === id)?.attrs['label']).toBe('电源灯');
  });

  it('number 属性失焦提交并经过 updateAttr（RGB LED 亮度）', () => {
    s().addPart('wokwi-rgb-led', { x: 400, y: 200 });
    render(<InspectorPanel />);
    const input = screen.getByTestId('attr-brightness') as HTMLInputElement;
    expect(input.value).toBe('255');
    fireEvent.change(input, { target: { value: '128' } });
    fireEvent.blur(input);
    expect(s().doc.parts.find((p) => p.type === 'wokwi-rgb-led')?.attrs['brightness']).toBe(128);
  });

  it('boolean/color 控件映射（临时目录注入）', () => {
    const def: PartDefinition = {
      type: 'wokwi-test-switch',
      name: '测试件',
      category: 'io',
      defVersion: 1,
      pins: [{ name: 'A', role: 'passive', x: 10, y: 10 }],
      attrs: [
        { key: 'enabled', type: 'boolean', label: '启用', default: false },
        { key: 'tint', type: 'color', label: '着色', default: '#00ff00' },
      ],
      renderer: { asset: 'x.svg', width: 20, height: 20 },
      simulator: { listens: [], behavior: 'test' },
    };
    const catalog = P1_CATALOG as Map<string, PartDefinition>; // 测试注入临时定义
    catalog.set(def.type, def);
    p1ValidationContext.partTypes.add(def.type);
    try {
      s().replaceDoc({
        ...createDefaultDoc(),
        parts: [
          ...createDefaultDoc().parts,
          { id: 't1', type: def.type, left: 100, top: 100, rotate: 0, attrs: {} },
        ],
      });
      s().selectPart('t1');
      render(<InspectorPanel />);
      const sw = screen.getByTestId('attr-enabled');
      expect(sw.getAttribute('aria-checked')).toBe('false');
      fireEvent.click(sw);
      expect(s().doc.parts.find((p) => p.id === 't1')?.attrs['enabled']).toBe(true);
      const color = screen.getByTestId('attr-tint') as HTMLInputElement;
      expect(color.type).toBe('color');
      fireEvent.change(color, { target: { value: '#123456' } });
      expect(s().doc.parts.find((p) => p.id === 't1')?.attrs['tint']).toBe('#123456');
    } finally {
      catalog.delete(def.type);
      p1ValidationContext.partTypes.delete(def.type);
    }
  });

  it('位置输入失焦提交 movePart（吸附 20px 网格）', () => {
    const id = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    render(<InspectorPanel />);
    const inputs = document.querySelectorAll('input[type="number"]');
    const xInput = inputs[0] as HTMLInputElement;
    expect(xInput.value).toBe('400');
    fireEvent.change(xInput, { target: { value: '333' } });
    fireEvent.blur(xInput);
    const p = s().doc.parts.find((x) => x.id === id);
    expect([p?.left, p?.top]).toEqual([340, 200]);
  });

  it('旋转按钮 +90°', () => {
    const id = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    render(<InspectorPanel />);
    fireEvent.click(screen.getByTitle('旋转 90°（快捷键 R）'));
    expect(s().doc.parts.find((p) => p.id === id)?.rotate).toBe(90);
  });

  it('板卡无删除按钮，普通元件有', () => {
    render(<InspectorPanel />);
    act(() => {
      s().selectPart('esp');
    });
    expect(screen.queryByText('删除元件（Del）')).toBeNull();
    act(() => {
      s().addPart('wokwi-led', { x: 400, y: 200 }); // addPart 自动选中新元件
    });
    expect(screen.getByText('删除元件（Del）')).toBeTruthy();
    fireEvent.click(screen.getByText('删除元件（Del）'));
    expect(s().doc.parts).toHaveLength(1);
  });

  it('多选显示批量面板', () => {
    const a = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    const b = s().addPart('wokwi-led', { x: 600, y: 200 })!;
    s().selectPart(a);
    s().selectPart(b, true);
    render(<InspectorPanel />);
    expect(screen.getByText('已选 2 个元件')).toBeTruthy();
    fireEvent.click(screen.getByText('批量旋转 90°'));
    expect(s().doc.parts.find((p) => p.id === a)?.rotate).toBe(90);
    expect(s().doc.parts.find((p) => p.id === b)?.rotate).toBe(90);
  });
});

describe('连线属性', () => {
  function setupWire() {
    const led = s().addPart('wokwi-led', { x: 400, y: 200 })!;
    const w = s().addConnection('esp:GPIO4', `${led}:A`)!;
    s().updateWirePath(w, [
      { dir: 'v', len: 40 },
      { dir: 'h', len: 60 },
    ]);
    return w;
  }

  it('色板换色', () => {
    const w = setupWire();
    render(<InspectorPanel />);
    fireEvent.click(screen.getByTestId('wire-color-purple'));
    expect(s().doc.connections.find((c) => c.id === w)?.color).toBe('purple');
  });

  it('锚点长度修改 + 删除段', () => {
    const w = setupWire();
    render(<InspectorPanel />);
    const len0 = document.querySelector(
      '[data-testid="anchor-0"] input[type="number"]',
    ) as HTMLInputElement;
    fireEvent.change(len0, { target: { value: '80' } });
    fireEvent.blur(len0);
    expect(s().doc.connections.find((c) => c.id === w)?.path).toEqual([
      { dir: 'v', len: 80 },
      { dir: 'h', len: 60 },
    ]);
    // 删除第一段
    fireEvent.click(document.querySelector('[data-testid="anchor-0"] [title="删除此段"]')!);
    expect(s().doc.connections.find((c) => c.id === w)?.path).toEqual([{ dir: 'h', len: 60 }]);
  });

  it('自动布线清空 path，删除连线移除', () => {
    const w = setupWire();
    render(<InspectorPanel />);
    fireEvent.click(screen.getByTitle('清空锚点，恢复自动正交布线'));
    expect(s().doc.connections.find((c) => c.id === w)?.path).toEqual([]);
    fireEvent.click(screen.getByText('删除连线（Del）'));
    expect(s().doc.connections).toHaveLength(0);
  });
});
