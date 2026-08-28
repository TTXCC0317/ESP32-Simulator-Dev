import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DiagramTab from './DiagramTab';
import { useCircuitStore } from '../circuit/circuitStore';
import { WOKWI_BLINK_SAMPLE, buildDiagramText } from '../circuit/diagram';

/**
 * diagram.json Tab L2（02-M2 验收）：
 * - 画布 → JSON 同步；应用到画布替换 doc；
 * - 非法 JSON 报错且不破坏画布；放弃修改回滚；载入示例。
 */

const s = () => useCircuitStore.getState();

beforeEach(() => {
  useCircuitStore.getState().__reset();
});

afterEach(() => {
  cleanup();
});

const textArea = () => screen.getByTestId('diagram-text') as HTMLTextAreaElement;

describe('diagram.json Tab', () => {
  it('初始显示画布当前文档', () => {
    render(<DiagramTab />);
    expect(JSON.parse(textArea().value)).toMatchObject({
      boardType: 'board-esp32-devkit-c-v4',
    });
  });

  it('应用到画布：合法 JSON 替换 doc', () => {
    render(<DiagramTab />);
    fireEvent.change(textArea(), { target: { value: WOKWI_BLINK_SAMPLE } });
    fireEvent.click(screen.getByTestId('diagram-apply'));
    const doc = s().doc;
    expect(doc.parts.map((p) => p.type)).toContain('wokwi-led');
    expect(doc.connections).toHaveLength(3);
    expect(s().dirty).toBe(true);
    // 应用后文本回写为规范化的画布导出（edited=false 跟随 doc）
    expect(textArea().value).toBe(buildDiagramText(doc));
  });

  it('非法 JSON：报错且画布不被破坏', () => {
    render(<DiagramTab />);
    const before = s().doc;
    fireEvent.change(textArea(), { target: { value: '{ 这不是合法 JSON' } });
    fireEvent.click(screen.getByTestId('diagram-apply'));
    expect(screen.getByTestId('diagram-errors')).toBeTruthy();
    expect(s().doc).toBe(before); // 引用未变 → 画布安全
    expect(s().doc.parts).toHaveLength(1);
  });

  it('合法 JSON 但含未收录类型：跳过并提示，其余照常应用', () => {
    render(<DiagramTab />);
    const sample = JSON.stringify({
      parts: [
        { type: 'board-esp32-devkit-c-v4', id: 'esp', top: 0, left: 0, attrs: {} },
        { type: 'wokwi-mystery-part', id: 'mx', top: 0, left: 0, attrs: {} },
        { type: 'wokwi-led', id: 'led1', top: -80, left: 280, attrs: {} },
      ],
      connections: [['esp:GPIO4', 'led1:A', 'green', ['v0']]],
    });
    fireEvent.change(textArea(), { target: { value: sample } });
    fireEvent.click(screen.getByTestId('diagram-apply'));
    expect(screen.getByTestId('diagram-notice').textContent).toContain('wokwi-mystery-part');
    expect(s().doc.parts.map((p) => p.type)).toEqual(['board-esp32-devkit-c-v4', 'wokwi-led']);
  });

  it('放弃修改：回滚到画布当前状态', () => {
    render(<DiagramTab />);
    fireEvent.change(textArea(), { target: { value: '{"broken": true}' } });
    expect((screen.getByText('放弃修改') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('放弃修改'));
    expect(JSON.parse(textArea().value)).toMatchObject({
      boardType: 'board-esp32-devkit-c-v4',
    });
  });

  it('载入示例：注入 Wokwi blink 文本', () => {
    render(<DiagramTab />);
    fireEvent.click(screen.getByText('载入示例'));
    expect(textArea().value).toBe(WOKWI_BLINK_SAMPLE);
  });

  it('画布变更且未手动编辑时自动跟随', () => {
    render(<DiagramTab />);
    act(() => {
      s().addPart('wokwi-led', { x: 400, y: 200 });
    });
    expect(JSON.parse(textArea().value).parts).toHaveLength(2);
  });
});
