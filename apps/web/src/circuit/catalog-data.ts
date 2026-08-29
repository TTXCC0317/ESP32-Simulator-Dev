import { partDefinitionSchema, type PartDefinition } from '@esp32-sim/shared';
import boardJson from '../../../../config/parts/board-esp32-devkit-c-v4.json';
import buzzerJson from '../../../../config/parts/wokwi-buzzer.json';
import ledJson from '../../../../config/parts/wokwi-led.json';
import pushbuttonJson from '../../../../config/parts/wokwi-pushbutton.json';
import potentiometerJson from '../../../../config/parts/wokwi-potentiometer.json';
import resistorJson from '../../../../config/parts/wokwi-resistor.json';
import rgbLedJson from '../../../../config/parts/wokwi-rgb-led.json';
import slideSwitchJson from '../../../../config/parts/wokwi-slide-switch.json';

/**
 * 元件目录数据源（M3 起唯一源为 config/parts/*.json，与 server catalog.service 读同一批文件，
 * 经 partDefinitionSchema zod 校验——《05-元件清单》§1 /《03-核心模块详细设计》§2.2）。
 * dev 期 Vite 直接打包 JSON（无网络请求）；运行期 /api/parts 与此同源，M8 静态托管后一致。
 * 与文档的偏差修正（05 已同步修订）：板卡左列 18 脚 / 右列 19 脚、首脚 y=32、间距 18px；
 * wokwi-rgb-led 封装 56×62（B 脚 x=44）。
 */

const SOURCES = [
  boardJson,
  ledJson,
  rgbLedJson,
  pushbuttonJson,
  resistorJson,
  potentiometerJson,
  slideSwitchJson,
  buzzerJson,
] as const;

/** zod 校验（配置为边界输入，校验失败 fail-fast——配置错误应在开发期暴露） */
export const P1_PART_DEFINITIONS: PartDefinition[] = SOURCES.map((raw) =>
  partDefinitionSchema.parse(raw),
);

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
