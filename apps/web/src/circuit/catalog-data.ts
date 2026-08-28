import type { PartDefinition } from '@esp32-sim/shared';

/**
 * P1 元件定义（《05-元件清单》§1）——M2 客户端内置版。
 * M3 起 catalog 由 config/parts/*.json 落地并经 GET /api/parts 下发（本文件届时退役或改为缓存兜底）。
 *
 * 与文档的偏差修正（05 已同步修订）：
 * - 板卡：左列 18 脚 / 右列 19 脚，首脚 y=32、脚间距 18px（原文"两侧各 19 脚 + 间距 20px + 首脚 y=40"
 *   在 380px 高度内装不下 19 脚）；
 * - wokwi-rgb-led：封装 56×62（原文 40×62 装不下 B 脚 x=44）。
 */

/** 板卡引脚（name / role / direction / 左右列）——《05-元件清单》§1.1 引脚表 */
type BoardPinSpec = {
  name: string;
  role: 'power' | 'gnd' | 'gpio';
  direction?: 'in' | 'out' | 'io';
  side: 'L' | 'R';
};

const BOARD_PINS: BoardPinSpec[] = [
  // 左列（自上而下，18 脚）
  { name: 'EN', role: 'power', side: 'L' },
  { name: 'VP', role: 'gpio', direction: 'in', side: 'L' },
  { name: 'VN', role: 'gpio', direction: 'in', side: 'L' },
  { name: 'GPIO34', role: 'gpio', direction: 'in', side: 'L' },
  { name: 'GPIO35', role: 'gpio', direction: 'in', side: 'L' },
  { name: 'GPIO32', role: 'gpio', direction: 'io', side: 'L' },
  { name: 'GPIO33', role: 'gpio', direction: 'io', side: 'L' },
  { name: 'GPIO25', role: 'gpio', direction: 'io', side: 'L' },
  { name: 'GPIO26', role: 'gpio', direction: 'io', side: 'L' },
  { name: 'GPIO27', role: 'gpio', direction: 'io', side: 'L' },
  { name: 'GPIO14', role: 'gpio', direction: 'io', side: 'L' },
  { name: 'GPIO12', role: 'gpio', direction: 'io', side: 'L' },
  { name: 'GND.2', role: 'gnd', side: 'L' },
  { name: 'GPIO13', role: 'gpio', direction: 'io', side: 'L' },
  { name: 'D2', role: 'gpio', direction: 'io', side: 'L' },
  { name: 'D3', role: 'gpio', direction: 'io', side: 'L' },
  { name: 'CMD', role: 'gpio', direction: 'io', side: 'L' },
  { name: '5V', role: 'power', side: 'L' },
  // 右列（自上而下，19 脚）：补齐 GPIO0–GPIO23 常用引脚（05-§1.1 2026-08-28 修订版）
  { name: 'GND.1', role: 'gnd', side: 'R' },
  { name: 'GPIO4', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO0', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO2', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO15', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO5', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO18', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO19', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO21', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO22', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO23', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO1', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO3', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO16', role: 'gpio', direction: 'io', side: 'R' },
  { name: 'GPIO17', role: 'gpio', direction: 'io', side: 'R' },
  { name: '3V3', role: 'power', side: 'R' },
  { name: 'VP', role: 'gpio', direction: 'in', side: 'R' },
  { name: 'VN', role: 'gpio', direction: 'in', side: 'R' },
  { name: 'EN', role: 'power', side: 'R' },
];

/** 板卡引脚坐标：首脚 y=32，间距 18px；左列 x=8，右列 x=232（按 BOARD_PINS 顺序递增） */
let li = 0;
let ri = 0;

const boardPins = BOARD_PINS.map((p) => {
  const x = p.side === 'L' ? 8 : 232;
  const y = 32 + (p.side === 'L' ? li++ : ri++) * 18;
  return { name: p.name, role: p.role, direction: p.direction, x, y };
});

export const BOARD_ESP32_DEVKIT_C_V4: PartDefinition = {
  type: 'board-esp32-devkit-c-v4',
  name: 'ESP32 DevKit-C V4',
  category: 'mcu',
  defVersion: 1,
  pins: boardPins,
  attrs: [],
  renderer: { asset: 'parts/board-esp32-devkit-c-v4.svg', width: 240, height: 380 },
  simulator: { listens: ['state'], behavior: 'mcu-board' },
};

export const WOKWI_LED: PartDefinition = {
  type: 'wokwi-led',
  name: 'LED',
  category: 'io',
  defVersion: 1,
  pins: [
    { name: 'A', role: 'signal.in', x: 20, y: 6 },
    { name: 'C', role: 'signal.out', x: 20, y: 56 },
  ],
  attrs: [
    {
      key: 'color',
      type: 'enum',
      label: '颜色',
      default: 'red',
      options: [
        { value: 'red', label: '红' },
        { value: 'green', label: '绿' },
        { value: 'blue', label: '蓝' },
        { value: 'yellow', label: '黄' },
        { value: 'white', label: '白' },
      ],
    },
    { key: 'label', type: 'text', label: '标签', default: '' },
  ],
  renderer: { asset: 'parts/wokwi-led.svg', width: 40, height: 62 },
  simulator: { listens: ['gpio.write', 'pwm.duty'], behavior: 'light-emitter' },
};

export const WOKWI_RGB_LED: PartDefinition = {
  type: 'wokwi-rgb-led',
  name: 'RGB LED',
  category: 'io',
  defVersion: 1,
  pins: [
    { name: 'R', role: 'signal.in', x: 8, y: 30 },
    { name: 'COM', role: 'signal.out', x: 20, y: 6 },
    { name: 'G', role: 'signal.in', x: 32, y: 30 },
    { name: 'B', role: 'signal.in', x: 44, y: 10 },
  ],
  attrs: [
    { key: 'brightness', type: 'number', label: '亮度', default: 255, min: 0, max: 255, step: 1 },
  ],
  renderer: { asset: 'parts/wokwi-rgb-led.svg', width: 56, height: 62 },
  simulator: { listens: ['gpio.write', 'pwm.duty'], behavior: 'light-emitter-rgb' },
};

export const WOKWI_PUSHBUTTON: PartDefinition = {
  type: 'wokwi-pushbutton',
  name: '按键',
  category: 'io',
  defVersion: 1,
  pins: [
    { name: '1.l', role: 'passive', x: 6, y: 30 },
    { name: '1.r', role: 'passive', x: 62, y: 30 },
    { name: '2.l', role: 'passive', x: 6, y: 44 },
    { name: '2.r', role: 'passive', x: 62, y: 44 },
  ],
  attrs: [
    {
      key: 'color',
      type: 'enum',
      label: '颜色',
      default: 'red',
      options: [
        { value: 'red', label: '红' },
        { value: 'green', label: '绿' },
        { value: 'blue', label: '蓝' },
        { value: 'yellow', label: '黄' },
        { value: 'white', label: '白' },
      ],
    },
    { key: 'label', type: 'text', label: '标签', default: '' },
  ],
  renderer: { asset: 'parts/wokwi-pushbutton.svg', width: 68, height: 68 },
  simulator: { listens: [], produces: ['pin.level'], behavior: 'momentary-switch' },
};

export const WOKWI_RESISTOR: PartDefinition = {
  type: 'wokwi-resistor',
  name: '电阻',
  category: 'io',
  defVersion: 1,
  pins: [
    { name: '1', role: 'passive', x: 4, y: 14 },
    { name: '2', role: 'passive', x: 72, y: 14 },
  ],
  attrs: [{ key: 'value', type: 'number', label: '阻值 (Ω)', default: 1000, min: 0, step: 100 }],
  renderer: { asset: 'parts/wokwi-resistor.svg', width: 76, height: 28 },
  simulator: { listens: [], behavior: 'passive-through' },
};

export const WOKWI_POTENTIOMETER: PartDefinition = {
  type: 'wokwi-potentiometer',
  name: '电位器',
  category: 'io',
  defVersion: 1,
  pins: [
    { name: 'GND', role: 'gnd', x: 12, y: 90 },
    { name: 'SIG', role: 'analog', x: 48, y: 90 },
    { name: 'VCC', role: 'power', x: 84, y: 90 },
  ],
  attrs: [
    { key: 'value', type: 'number', label: '位置 (%)', default: 50, min: 0, max: 100, step: 1 },
  ],
  renderer: { asset: 'parts/wokwi-potentiometer.svg', width: 96, height: 96 },
  simulator: { listens: [], produces: ['analog.value'], behavior: 'analog-source' },
};

export const WOKWI_SLIDE_SWITCH: PartDefinition = {
  type: 'wokwi-slide-switch',
  name: '滑动开关',
  category: 'io',
  defVersion: 1,
  pins: [
    { name: '1', role: 'passive', x: 8, y: 40 },
    { name: '2', role: 'passive', x: 44, y: 40 },
    { name: '3', role: 'passive', x: 80, y: 40 },
  ],
  attrs: [
    {
      key: 'position',
      type: 'enum',
      label: '位置',
      default: '1',
      options: [
        { value: '1', label: '1' },
        { value: '2', label: '2' },
      ],
    },
  ],
  renderer: { asset: 'parts/wokwi-slide-switch.svg', width: 88, height: 48 },
  simulator: { listens: [], produces: ['pin.level'], behavior: 'toggle-switch' },
};

export const WOKWI_BUZZER: PartDefinition = {
  type: 'wokwi-buzzer',
  name: '有源蜂鸣器',
  category: 'io',
  defVersion: 1,
  pins: [
    { name: 'GND', role: 'gnd', x: 36, y: 66 },
    { name: 'VCC', role: 'power', x: 36, y: 6 },
  ],
  attrs: [{ key: 'volume', type: 'number', label: '音量', default: 50, min: 0, max: 100, step: 1 }],
  renderer: { asset: 'parts/wokwi-buzzer.svg', width: 72, height: 72 },
  simulator: { listens: ['gpio.write', 'pwm.duty'], behavior: 'sound-emitter' },
};

/** P1 全部元件定义（board 在首位，与 CircuitDoc.parts[0] 为板卡的约定一致） */
export const P1_PART_DEFINITIONS: PartDefinition[] = [
  BOARD_ESP32_DEVKIT_C_V4,
  WOKWI_LED,
  WOKWI_RGB_LED,
  WOKWI_PUSHBUTTON,
  WOKWI_RESISTOR,
  WOKWI_POTENTIOMETER,
  WOKWI_SLIDE_SWITCH,
  WOKWI_BUZZER,
];

export const P1_CATALOG: ReadonlyMap<string, PartDefinition> = new Map(
  P1_PART_DEFINITIONS.map((d) => [d.type, d]),
);

/** 分类中文名（04-§4 分类树顺序） */
export const CATEGORY_LABELS: ReadonlyMap<PartDefinition['category'], string> = new Map([
  ['mcu', '开发板'],
  ['io', '基础IO'],
  ['sensor', '传感器'],
  ['display', '显示'],
  ['power', '电源'],
]);

/** ValidationContext 适配（shared validateCircuitDoc 用） */
export const p1ValidationContext = {
  partTypes: new Set(P1_CATALOG.keys()),
  pinNames: (type: string) => {
    const def = P1_CATALOG.get(type);
    return def ? new Set(def.pins.map((p) => p.name)) : undefined;
  },
};
