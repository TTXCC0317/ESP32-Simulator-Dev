import { describe, expect, it } from 'vitest';
import type { WireSegment } from '@esp32-sim/shared';
import {
  autoSegments,
  moveSegment,
  nextWireColor,
  pathToPoints,
  pinWorldPos,
  removeSegment,
  resolveWirePoints,
  setSegmentLen,
  snapToGrid,
  WIRE_COLOR_CYCLE,
  type Vec2,
} from './wiring';

const o: Vec2 = { x: 0, y: 0 };
const v = (x: number, y: number): Vec2 => ({ x, y });
const seg = (dir: 'v' | 'h' | '*', len: number): WireSegment => ({ dir, len });

describe('pathToPoints（v/h 语义）', () => {
  it('空路径 → 仅起点', () => {
    expect(pathToPoints(v(10, 20), [])).toEqual([v(10, 20)]);
  });
  it('v+40 → 垂直向下', () => {
    expect(pathToPoints(o, [seg('v', 40)])).toEqual([o, v(0, 40)]);
  });
  it('v-40 → 垂直向上', () => {
    expect(pathToPoints(o, [seg('v', -40)])).toEqual([o, v(0, -40)]);
  });
  it('h+60 → 水平向右', () => {
    expect(pathToPoints(o, [seg('h', 60)])).toEqual([o, v(60, 0)]);
  });
  it('h-60 → 水平向左', () => {
    expect(pathToPoints(o, [seg('h', -60)])).toEqual([o, v(-60, 0)]);
  });
  it('v 后 h：拐点在 (0,dy)', () => {
    expect(pathToPoints(o, [seg('v', 40), seg('h', 60)])).toEqual([o, v(0, 40), v(60, 40)]);
  });
  it('h 后 v：拐点在 (dx,0)，与 v/h 顺序相关', () => {
    expect(pathToPoints(o, [seg('h', 60), seg('v', 40)])).toEqual([o, v(60, 0), v(60, 40)]);
  });
  it('多段链式累积', () => {
    expect(pathToPoints(o, [seg('v', 20), seg('h', 20), seg('v', -20)])).toEqual([
      o,
      v(0, 20),
      v(20, 20),
      v(20, 0),
    ]);
  });
  it('零长段产生重复顶点（语义明确：不过滤）', () => {
    expect(pathToPoints(o, [seg('v', 0)])).toEqual([o, o]);
  });
  it("'*' 段在 pathToPoints 中视为无位移（由 resolveWirePoints 处理）", () => {
    expect(pathToPoints(o, [seg('*', 1), seg('h', 20)])).toEqual([o, o, v(20, 0)]);
  });
});

describe('autoSegments（先 v 后 h）', () => {
  it('直下 → 仅 v', () => {
    expect(autoSegments(o, v(0, 60))).toEqual([seg('v', 60)]);
  });
  it('直右 → 仅 h', () => {
    expect(autoSegments(o, v(60, 0))).toEqual([seg('h', 60)]);
  });
  it('对角 → v+h', () => {
    expect(autoSegments(o, v(60, 40))).toEqual([seg('v', 40), seg('h', 60)]);
  });
  it('同点 → 空段', () => {
    expect(autoSegments(o, o)).toEqual([]);
  });
  it('左上 → 负长度段', () => {
    expect(autoSegments(v(100, 100), v(40, 60))).toEqual([seg('v', -40), seg('h', -60)]);
  });
});

describe('resolveWirePoints（* 与兜底）', () => {
  it('空路径 → 自动 v-then-h', () => {
    expect(resolveWirePoints(o, v(60, 40), [])).toEqual([o, v(0, 40), v(60, 40)]);
  });
  it('显式完整路径原样解析', () => {
    expect(resolveWirePoints(o, v(60, 40), [seg('h', 60), seg('v', 40)])).toEqual([
      o,
      v(60, 0),
      v(60, 40),
    ]);
  });
  it("'*' 在起点 → 全自动", () => {
    expect(resolveWirePoints(o, v(60, 40), [seg('*', 0)])).toEqual([o, v(0, 40), v(60, 40)]);
  });
  it("'*' 在中段 → 前段保留、余下自动", () => {
    expect(resolveWirePoints(o, v(60, 40), [seg('v', 20), seg('*', 0)])).toEqual([
      o,
      v(0, 20),
      v(0, 40),
      v(60, 40),
    ]);
  });
  it("'*' 后的段被忽略", () => {
    expect(resolveWirePoints(o, v(60, 40), [seg('*', 0), seg('h', 999)])).toEqual([
      o,
      v(0, 40),
      v(60, 40),
    ]);
  });
  it('位移不匹配 → 兜底补终边到终点', () => {
    // 声明 v40+h60 但终点是 (60,60)：末点 (60,40) 后自动补 v20
    expect(resolveWirePoints(o, v(60, 60), [seg('v', 40), seg('h', 60)])).toEqual([
      o,
      v(0, 40),
      v(60, 40),
      v(60, 60),
    ]);
  });
  it('零长段兜底：终点即末点时不重复', () => {
    expect(resolveWirePoints(o, o, [seg('v', 0)])).toEqual([o]);
  });
});

describe('pinWorldPos（旋转感知）', () => {
  // LED 40×62，A(20,6) C(20,56)；中心 (20,31)
  const led = {
    id: 'led1',
    type: 'wokwi-led',
    left: 100,
    top: 200,
    rotate: 0 as const,
    attrs: {},
  };
  it('rotate 0：局部坐标直加', () => {
    expect(pinWorldPos(led, 'A')).toEqual(v(120, 206));
  });
  it('rotate 90：CW，(ox,oy)→(-oy,ox)', () => {
    // ox=0, oy=-25 → (25, 0) → (100+20+25, 200+31+0)
    expect(pinWorldPos({ ...led, rotate: 90 }, 'A')).toEqual(v(145, 231));
  });
  it('rotate 180：(ox,oy)→(-ox,-oy)', () => {
    expect(pinWorldPos({ ...led, rotate: 180 }, 'A')).toEqual(v(120, 256));
  });
  it('rotate 270：(ox,oy)→(oy,-ox)', () => {
    expect(pinWorldPos({ ...led, rotate: 270 }, 'A')).toEqual(v(95, 231));
  });
  it('未知引脚 → null', () => {
    expect(pinWorldPos(led, 'X')).toBeNull();
  });
  it('未知类型 → null', () => {
    expect(pinWorldPos({ ...led, type: 'wokwi-motor' }, 'A')).toBeNull();
  });
});

describe('nextWireColor（8 色轮转）', () => {
  it('首三根：绿红橙', () => {
    expect([nextWireColor(0), nextWireColor(1), nextWireColor(2)]).toEqual([
      'green',
      'red',
      'orange',
    ]);
  });
  it('循环周期为 8', () => {
    expect(nextWireColor(8)).toBe('green');
    expect(nextWireColor(9)).toBe('red');
  });
  it('负索引不越界', () => {
    expect(nextWireColor(-1)).toBe(WIRE_COLOR_CYCLE[7]);
  });
});

describe('snapToGrid（20px 网格）', () => {
  it.each([
    [45, 40],
    [50, 60],
    [12, 20],
    [-11, -20],
    [100, 100],
    [-0.5, -0],
  ])('snapToGrid(%i) = %i', (input, expected) => {
    expect(snapToGrid(input)).toBe(expected);
  });
});

describe('锚点（段）编辑', () => {
  const path = [seg('v', 40), seg('h', 60), seg('v', -20)];
  it('setSegmentLen 只改目标段', () => {
    expect(setSegmentLen(path, 1, 80)).toEqual([seg('v', 40), seg('h', 80), seg('v', -20)]);
  });
  it('moveSegment(+1) 与后段换序', () => {
    expect(moveSegment(path, 0, 1)).toEqual([seg('h', 60), seg('v', 40), seg('v', -20)]);
  });
  it('moveSegment(-1) 与前段换序', () => {
    expect(moveSegment(path, 2, -1)).toEqual([seg('v', 40), seg('v', -20), seg('h', 60)]);
  });
  it('moveSegment 越界返回原数组', () => {
    expect(moveSegment(path, 0, -1)).toBe(path);
    expect(moveSegment(path, 2, 1)).toBe(path);
  });
  it('removeSegment 删除指定段', () => {
    expect(removeSegment(path, 1)).toEqual([seg('v', 40), seg('v', -20)]);
  });
  it('编辑不改变原数组（纯函数）', () => {
    const copy = [...path];
    setSegmentLen(path, 0, 99);
    moveSegment(path, 0, 1);
    removeSegment(path, 0);
    expect(path).toEqual(copy);
  });
});
