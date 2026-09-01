import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { PartDefinition, PartInstance, PinRef } from '@esp32-sim/shared';
import { Circle, Ellipse, Group, Image, Line, Rect, Text } from 'react-konva';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useCircuitStore } from '../circuit/circuitStore';
import { P1_CATALOG } from '../circuit/catalog-data';
import { useSimStore } from '../stores/sim';
import { useRuntimeStore, SSD1306_COLS } from '../stores/runtime';
import { useUiStore } from '../stores/ui';
import { startBuzzer, stopBuzzer } from '../audio/buzzer';
import {
  pressButton,
  releaseButton,
  setPotentiometerValue,
  setSensorData,
  toggleSwitch,
} from '../sim/part-input';
import { buildNetMap, type NetMap } from '../sim/net-map';
import {
  PART_BODY,
  PART_BODY_LIGHT,
  PART_STROKE,
  PIN_FILL,
  PIN_HOVER,
  PIN_STROKE,
  SELECTION_COLOR,
  TEXT_DIM,
} from './theme';

/**
 * PartLayer / PartView（03-§5.1 PartLayer、§5.2 PartView）：
 * 元件 SVG 资源 M3 落地（assets/parts/），M2 用 Konva 矢量形状绘制同布局占位。
 * 旋转围绕封装中心（与 pinWorldPos 计算一致）；引脚命中半径 6px。
 *
 * M5 元件行为（05-§1）：
 * - LED：A 网络电平驱动亮灭（C 需接 GND 网络，压差语义），pwm.duty 调亮度（duty/1023）；
 * - RGB LED：R/G/B 三通道网络电平混色（COM 共阴接 GND）；
 * - 蜂鸣器：VCC 电平 1 发声（AudioContext，muted 仅静音不灭视觉）；
 * - 按键/开关：运行中 pointer 交互 → part-input 注入（双引擎），同时本地视觉反馈。
 */

type KonvaE = KonvaEventObject<PointerEvent>;

/** 元件运行时视觉状态（bodyShape 渲染入参；M5/M7） */
interface RuntimeVisual {
  /** LED 点亮色（null=灭） */
  ledOn: boolean;
  /** PWM 亮度 0..1（无 pwm 时 1） */
  ledAlpha: number;
  /** RGB 混色（null=灭） */
  rgbColor: string | null;
  pressed: boolean;
  switchPos: '1' | '2';
  buzzing: boolean;
  /** 电位器旋钮角度（0–100% → −150°~+150° 摆幅 300°） */
  potentiometerAngle: number;
  /** 舵机摆臂角度（0–180°） */
  servoAngle: number;
  /** 电位器未接电源 → 画警告边框 */
  potWarn: boolean;
  /** M9 SSD1306 运行时帧画布（128×64 ImageData；null=非 OLED） */
  oledCanvas: HTMLCanvasElement | null;
  /** Konva Image 节点引用（putImageData 后手动 batchDraw，画布内容变化不触发 Konva 重绘） */
  oledImgRef: React.RefObject<Konva.Image | null> | null;
  /** M9 NeoPixel 各灯珠颜色（rgb() 字符串；灭=rgb(0,0,0)） */
  stripColors: string[];
}

interface PartViewProps {
  part: PartInstance;
  def: PartDefinition;
  selected: boolean;
  /** M8：I2C_ADDR_CONFLICT / SPI_CS_CONFLICT 红框标记 */
  conflict: boolean;
  hoverPin: string | null;
  wiringFrom: string | null;
  netMap: NetMap;
  runtimeActive: boolean;
  onPartPointerDown: (e: KonvaE, id: string) => void;
  onPinPointerDown: (e: KonvaE, pinRef: string) => void;
  onPinHover: (pinRef: string | null) => void;
}

const ATTR_COLORS: Record<string, string> = {
  red: '#e5484d',
  green: '#46a758',
  blue: '#3b82f6',
  yellow: '#eab308',
  white: '#e8eaf0',
};

const PWM_DUTY_MAX = 1023; // MicroPython ESP32 默认 10bit duty 上限

function bodyShape(part: PartInstance, def: PartDefinition, rt: RuntimeVisual) {
  const w = def.renderer.width;
  const h = def.renderer.height;
  switch (def.type) {
    case 'board-esp32-devkit-c-v4':
      return (
        <Fragment>
          <Rect
            width={w}
            height={h}
            cornerRadius={10}
            fill="#173625"
            stroke={PART_STROKE}
            strokeWidth={2}
          />
          <Rect x={w / 2 - 45} y={-6} width={90} height={14} cornerRadius={4} fill={PART_BODY} />
          <Text
            x={w / 2 - 70}
            y={h / 2 - 30}
            width={140}
            text="ESP32 DevKit-C V4"
            align="center"
            fontSize={13}
            fill={TEXT_DIM}
            listening={false}
          />
        </Fragment>
      );
    case 'wokwi-led': {
      const c = ATTR_COLORS[String(part.attrs['color'] ?? 'red')] ?? '#e5484d';
      return (
        <Fragment>
          <Line
            points={[20, 6, 20, 20, 20, 44, 20, 56]}
            stroke="#b7bcc6"
            strokeWidth={2}
            listening={false}
          />
          {rt.ledOn && (
            <Ellipse
              x={20}
              y={32}
              radiusX={22}
              radiusY={26}
              fill={c}
              opacity={0.15 + 0.2 * rt.ledAlpha}
              listening={false}
            />
          )}
          <Ellipse
            x={20}
            y={32}
            radiusX={14}
            radiusY={18}
            fill={c}
            opacity={rt.ledOn ? 0.9 : 0.35}
            stroke={c}
            strokeWidth={2}
          />
          <Ellipse
            x={20}
            y={32}
            radiusX={7}
            radiusY={9}
            fill={c}
            opacity={rt.ledOn ? 0.55 + 0.45 * rt.ledAlpha : 0.55}
            listening={false}
          />
        </Fragment>
      );
    }
    case 'wokwi-rgb-led': {
      const fill = rt.rgbColor ?? '#e8eaf0';
      return (
        <Fragment>
          <Line
            points={[8, 30, 20, 44, 20, 56]}
            stroke="#b7bcc6"
            strokeWidth={2}
            listening={false}
          />
          <Line points={[20, 6, 20, 24]} stroke="#b7bcc6" strokeWidth={2} listening={false} />
          <Line points={[32, 30, 24, 44]} stroke="#b7bcc6" strokeWidth={2} listening={false} />
          <Line points={[44, 10, 28, 30]} stroke="#b7bcc6" strokeWidth={2} listening={false} />
          {rt.rgbColor && (
            <Ellipse
              x={24}
              y={40}
              radiusX={22}
              radiusY={23}
              fill={rt.rgbColor}
              opacity={0.2}
              listening={false}
            />
          )}
          <Ellipse
            x={24}
            y={40}
            radiusX={15}
            radiusY={16}
            fill={fill}
            opacity={rt.rgbColor ? 0.85 : 0.25}
            stroke={fill}
            strokeWidth={2}
          />
        </Fragment>
      );
    }
    case 'wokwi-pushbutton': {
      const c = ATTR_COLORS[String(part.attrs['color'] ?? 'red')] ?? '#e5484d';
      const knobY = rt.pressed ? 41 : 39;
      return (
        <Fragment>
          <Rect
            x={2}
            y={20}
            width={64}
            height={38}
            cornerRadius={6}
            fill={PART_BODY}
            stroke={PART_STROKE}
            strokeWidth={2}
          />
          <Circle x={34} y={knobY} radius={12} fill={c} opacity={rt.pressed ? 0.6 : 0.85} />
          <Circle
            x={34}
            y={knobY}
            radius={12}
            fill="transparent"
            stroke={PART_STROKE}
            strokeWidth={1}
          />
        </Fragment>
      );
    }
    case 'wokwi-resistor':
      return (
        <Fragment>
          <Line points={[4, 14, 16, 14]} stroke="#b7bcc6" strokeWidth={2} listening={false} />
          <Line points={[60, 14, 72, 14]} stroke="#b7bcc6" strokeWidth={2} listening={false} />
          <Rect
            x={16}
            y={6}
            width={44}
            height={16}
            cornerRadius={7}
            fill="#d7b98c"
            stroke="#8a6420"
            strokeWidth={1}
          />
          <Rect x={26} y={6} width={4} height={16} fill="#7a4a20" listening={false} />
          <Rect x={36} y={6} width={4} height={16} fill="#7a4a20" listening={false} />
          <Rect x={46} y={6} width={4} height={16} fill="#c9a227" listening={false} />
        </Fragment>
      );
    case 'wokwi-potentiometer':
      return (
        <Fragment>
          <Rect
            x={8}
            y={12}
            width={80}
            height={70}
            cornerRadius={8}
            fill={PART_BODY_LIGHT}
            stroke={rt.potWarn ? '#dc2626' : PART_STROKE}
            strokeWidth={rt.potWarn ? 3 : 2}
          />
          <Circle x={48} y={42} radius={22} fill={PART_BODY} stroke={PART_STROKE} strokeWidth={2} />
          <Group x={48} y={42} rotation={rt.potentiometerAngle}>
            <Line points={[0, 0, 0, -18]} stroke={TEXT_DIM} strokeWidth={3} listening={false} />
          </Group>
        </Fragment>
      );
    case 'wokwi-slide-switch': {
      const knobX = rt.switchPos === '2' ? 58 : 22;
      return (
        <Fragment>
          <Rect
            x={4}
            y={18}
            width={80}
            height={24}
            cornerRadius={12}
            fill={PART_BODY}
            stroke={PART_STROKE}
            strokeWidth={2}
          />
          <Rect x={knobX} y={22} width={16} height={16} cornerRadius={4} fill={TEXT_DIM} />
        </Fragment>
      );
    }
    case 'wokwi-buzzer':
      return (
        <Fragment>
          {rt.buzzing && (
            <Fragment>
              <Circle
                x={36}
                y={36}
                radius={34}
                stroke={TEXT_DIM}
                strokeWidth={1.5}
                opacity={0.5}
                listening={false}
              />
              <Circle
                x={36}
                y={36}
                radius={41}
                stroke={TEXT_DIM}
                strokeWidth={1}
                opacity={0.3}
                listening={false}
              />
            </Fragment>
          )}
          <Circle x={36} y={36} radius={29} fill={PART_BODY} stroke={PART_STROKE} strokeWidth={2} />
          <Circle x={36} y={36} radius={6} fill="#111318" stroke={PART_STROKE} strokeWidth={1} />
          <Text x={20} y={52} text="BUZZER" fontSize={8} fill={TEXT_DIM} listening={false} />
        </Fragment>
      );
    case 'wokwi-servo': {
      const w = def.renderer.width;
      const h = def.renderer.height;
      return (
        <Fragment>
          {/* 安装法兰（左右两耳） */}
          <Rect
            x={4}
            y={6}
            width={12}
            height={32}
            cornerRadius={3}
            fill={PART_BODY_LIGHT}
            stroke={PART_STROKE}
            strokeWidth={1}
          />
          <Rect
            x={w - 16}
            y={6}
            width={12}
            height={32}
            cornerRadius={3}
            fill={PART_BODY_LIGHT}
            stroke={PART_STROKE}
            strokeWidth={1}
          />
          <Circle x={10} cy={22} r={2.5} fill={PART_STROKE} />
          <Circle x={w - 10} cy={22} r={2.5} fill={PART_STROKE} />
          {/* 主体 */}
          <Rect
            x={14}
            y={14}
            width={w - 28}
            height={56}
            cornerRadius={6}
            fill={PART_BODY}
            stroke={PART_STROKE}
            strokeWidth={2}
          />
          {/* 舵盘 + 摆臂（旋转中心 = 主体顶部中心，x=w/2, y≈42） */}
          <Group x={w / 2} y={42} rotation={rt.servoAngle - 90}>
            {/* 舵盘圆形 */}
            <Circle radius={14} fill={PART_BODY_LIGHT} stroke={PART_STROKE} strokeWidth={1.5} />
            {/* 摆臂（从中心向"上方"伸出，rotation 控制方向） */}
            <Rect
              x={-2}
              y={-30}
              width={4}
              height={34}
              cornerRadius={2}
              fill="#1f2937"
              stroke={PART_STROKE}
              strokeWidth={1}
            />
            {/* 摆臂端小圆 */}
            <Circle x={0} y={-26} r={3} fill="#111827" />
          </Group>
          {/* 底部引脚标识（文字） */}
          <Text
            x={8}
            y={h - 6}
            width={20}
            text="G"
            fontSize={7}
            fill={TEXT_DIM}
            align="center"
            listening={false}
          />
          <Text
            x={w / 2 - 10}
            y={h - 6}
            width={20}
            text="V"
            fontSize={7}
            fill={TEXT_DIM}
            align="center"
            listening={false}
          />
          <Text
            x={w - 28}
            y={h - 6}
            width={20}
            text="S"
            fontSize={7}
            fill={TEXT_DIM}
            align="center"
            listening={false}
          />
        </Fragment>
      );
    }
    case 'wokwi-bh1750': {
      return (
        <Fragment>
          <Rect
            width={w}
            height={h}
            cornerRadius={6}
            fill={PART_BODY}
            stroke={PART_STROKE}
            strokeWidth={2}
          />
          <Rect
            x={12}
            y={12}
            width={72}
            height={36}
            cornerRadius={3}
            fill="#0f3d6b"
            stroke="#1f5a8a"
            strokeWidth={1}
          />
          <Text
            x={0}
            y={20}
            width={w}
            text="BH1750"
            align="center"
            fontSize={9}
            fill={TEXT_DIM}
            listening={false}
          />
          <Text
            x={0}
            y={68}
            width={w}
            text="LUX"
            align="center"
            fontSize={7}
            fill={TEXT_DIM}
            listening={false}
          />
        </Fragment>
      );
    }
    case 'wokwi-mpu6050': {
      return (
        <Fragment>
          <Rect
            width={w}
            height={h}
            cornerRadius={6}
            fill={PART_BODY}
            stroke={PART_STROKE}
            strokeWidth={2}
          />
          <Rect
            x={12}
            y={20}
            width={72}
            height={40}
            cornerRadius={3}
            fill="#3b1d6b"
            stroke="#5a2f8a"
            strokeWidth={1}
          />
          <Text
            x={0}
            y={28}
            width={w}
            text="MPU6050"
            align="center"
            fontSize={9}
            fill={TEXT_DIM}
            listening={false}
          />
          <Text
            x={0}
            y={80}
            width={w}
            text="6-DOF IMU"
            align="center"
            fontSize={7}
            fill={TEXT_DIM}
            listening={false}
          />
          <Text
            x={0}
            y={92}
            width={w}
            text="ACCEL+GYRO"
            align="center"
            fontSize={6}
            fill={TEXT_DIM}
            listening={false}
          />
        </Fragment>
      );
    }
    case 'wokwi-w25q32': {
      return (
        <Fragment>
          <Rect
            width={w}
            height={h}
            cornerRadius={6}
            fill={PART_BODY}
            stroke={PART_STROKE}
            strokeWidth={2}
          />
          <Rect
            x={12}
            y={24}
            width={72}
            height={40}
            cornerRadius={3}
            fill="#1a4d2e"
            stroke="#2f7a45"
            strokeWidth={1}
          />
          <Text
            x={0}
            y={32}
            width={w}
            text="W25Q32"
            align="center"
            fontSize={9}
            fill={TEXT_DIM}
            listening={false}
          />
          <Text
            x={0}
            y={88}
            width={w}
            text="SPI FLASH"
            align="center"
            fontSize={7}
            fill={TEXT_DIM}
            listening={false}
          />
          <Text
            x={0}
            y={100}
            width={w}
            text="32Mbit"
            align="center"
            fontSize={6}
            fill={TEXT_DIM}
            listening={false}
          />
        </Fragment>
      );
    }
    case 'wokwi-dht22': {
      return (
        <Fragment>
          <Rect
            width={w}
            height={h}
            cornerRadius={6}
            fill={PART_BODY}
            stroke={PART_STROKE}
            strokeWidth={2}
          />
          <Rect
            x={10}
            y={16}
            width={72}
            height={44}
            cornerRadius={4}
            fill="#0a3a5e"
            stroke="#1f6a8a"
            strokeWidth={1}
          />
          <Text
            x={0}
            y={28}
            width={w}
            text="DHT22"
            align="center"
            fontSize={10}
            fill={TEXT_DIM}
            listening={false}
          />
          <Text
            x={0}
            y={42}
            width={w}
            text="TEMP/HUM"
            align="center"
            fontSize={7}
            fill={TEXT_DIM}
            listening={false}
          />
          <Rect
            x={16}
            y={72}
            width={52}
            height={14}
            cornerRadius={2}
            fill="#1a1d24"
            stroke="#3a3f4a"
            strokeWidth={0.5}
          />
          <Text
            x={0}
            y={82}
            width={w}
            text="AM2302"
            align="center"
            fontSize={6}
            fill={TEXT_DIM}
            listening={false}
          />
        </Fragment>
      );
    }
    case 'wokwi-ssd1306': {
      /* 屏幕布局与 wokwi-ssd1306.svg 对齐：外屏 (20,8) 132×68，有效像素 (22,10) 128×64 */
      return (
        <Fragment>
          <Rect
            width={w}
            height={h}
            cornerRadius={6}
            fill={PART_BODY}
            stroke={PART_STROKE}
            strokeWidth={2}
          />
          <Rect
            x={20}
            y={8}
            width={132}
            height={68}
            cornerRadius={2}
            fill="#051018"
            stroke="#0a2030"
            strokeWidth={1}
            listening={false}
          />
          {rt.oledCanvas && (
            <Image
              ref={(rt.oledImgRef ?? undefined) as React.Ref<Konva.Image> | undefined}
              x={22}
              y={10}
              width={128}
              height={64}
              image={rt.oledCanvas}
              listening={false}
            />
          )}
          <Text
            x={0}
            y={92}
            width={w}
            text="SSD1306"
            align="center"
            fontSize={9}
            fill={TEXT_DIM}
            listening={false}
          />
        </Fragment>
      );
    }
    case 'wokwi-led-strip': {
      /* 灯珠网格布局（≤8 单行 / ≤16 两行 / ≤30 三行 / 其余四行），颜色来自 neopixelFrames */
      const n = rt.stripColors.length;
      const rows = n <= 8 ? 1 : n <= 16 ? 2 : n <= 30 ? 3 : 4;
      const cols = Math.max(1, Math.ceil(n / rows));
      const x0 = 34;
      const x1 = 122;
      const yTop = 20;
      const yBot = 106;
      const dx = cols > 1 ? (x1 - x0) / (cols - 1) : 0;
      const dy = rows > 1 ? (yBot - yTop) / (rows - 1) : 0;
      const r = Math.max(2.5, Math.min(7, Math.min(dx || 88, dy || 88) / 2 - 0.6));
      return (
        <Fragment>
          <Rect
            width={w}
            height={h}
            cornerRadius={8}
            fill={PART_BODY}
            stroke={PART_STROKE}
            strokeWidth={2}
          />
          <Rect x={1} y={1} width={20} height={h - 2} cornerRadius={8} fill="#262b35" />
          {rt.stripColors.map((c, i) => {
            const rowIdx = Math.floor(i / cols);
            const colIdx = i % cols;
            const px = cols > 1 ? x0 + colIdx * dx : (x0 + x1) / 2;
            const py = rows > 1 ? yTop + rowIdx * dy : (yTop + yBot) / 2;
            return (
              <Circle
                key={i}
                x={px}
                y={py}
                radius={r}
                fill={c}
                stroke="#3a3f4a"
                strokeWidth={0.8}
                listening={false}
              />
            );
          })}
          <Text
            x={28}
            y={h - 10}
            width={w - 30}
            text="WS2812"
            align="center"
            fontSize={8}
            fill={TEXT_DIM}
            listening={false}
          />
        </Fragment>
      );
    }
    default:
      return <Rect width={w} height={h} fill={PART_BODY} stroke={PART_STROKE} strokeWidth={2} />;
  }
}

export function PartView(props: PartViewProps) {
  // wiringFrom 仅用于类型签名（CircuitCanvas 传入），高亮渲染由引脚 hover 逻辑覆盖
  const {
    part,
    def,
    selected,
    conflict,
    hoverPin,
    netMap,
    runtimeActive,
    onPartPointerDown,
    onPinPointerDown,
    onPinHover,
  } = props;
  const { width: w, height: h } = def.renderer;
  const label = String(part.attrs['label'] ?? '') || def.name;

  // ---- M5 元件运行时（hooks 顶层无条件调用；各类型只消费自己的分支） ----

  // LED：A 网络 GPIO 电平 + C 侧 GND 压差语义（05-§1.2）
  const ledGpio = useMemo(
    () => (def.type === 'wokwi-led' ? netMap.gpioOf(`${part.id}:A`) : null),
    [def.type, netMap, part.id],
  );
  const ledLevel = useRuntimeStore((s) =>
    ledGpio !== null ? (s.gpioLevels.get(ledGpio) ?? 0) : 0,
  );
  const ledPwm = useRuntimeStore((s) =>
    ledGpio !== null ? (s.pwmDuties.get(ledGpio) ?? null) : null,
  );
  const ledGrounded = useMemo(
    () => (def.type === 'wokwi-led' ? netMap.netRoleOf(`${part.id}:C`) === 'gnd' : false),
    [def.type, netMap, part.id],
  );

  // RGB LED：R/G/B 三通道（COM 共阴需接 GND，05-§1.3）
  const rgbGpios = useMemo(() => {
    if (def.type !== 'wokwi-rgb-led') return null;
    return {
      r: netMap.gpioOf(`${part.id}:R`),
      g: netMap.gpioOf(`${part.id}:G`),
      b: netMap.gpioOf(`${part.id}:B`),
    };
  }, [def.type, netMap, part.id]);
  const rgbGrounded = useMemo(
    () => def.type === 'wokwi-rgb-led' && netMap.netRoleOf(`${part.id}:COM`) === 'gnd',
    [def.type, netMap, part.id],
  );
  const rLevel = useRuntimeStore((s) =>
    rgbGpios?.r != null ? (s.gpioLevels.get(rgbGpios.r) ?? 0) : 0,
  );
  const gLevel = useRuntimeStore((s) =>
    rgbGpios?.g != null ? (s.gpioLevels.get(rgbGpios.g) ?? 0) : 0,
  );
  const bLevel = useRuntimeStore((s) =>
    rgbGpios?.b != null ? (s.gpioLevels.get(rgbGpios.b) ?? 0) : 0,
  );

  // 蜂鸣器：VCC 网络电平驱动（05-§1.8）
  const buzzGpio = useMemo(
    () => (def.type === 'wokwi-buzzer' ? netMap.gpioOf(`${part.id}:VCC`) : null),
    [def.type, netMap, part.id],
  );
  const buzzLevel = useRuntimeStore((s) =>
    buzzGpio !== null ? (s.gpioLevels.get(buzzGpio) ?? 0) : 0,
  );
  const volume = Number(part.attrs['volume'] ?? 50);
  const muted = useUiStore((s) => s.muted);
  const buzzing = def.type === 'wokwi-buzzer' && buzzLevel === 1;

  // 蜂鸣器音频生命周期：muted/未解锁只静音，波纹视觉照常（E4）
  useEffect(() => {
    if (def.type !== 'wokwi-buzzer') return;
    if (buzzing && runtimeActive) startBuzzer(volume, muted);
    else stopBuzzer();
    return stopBuzzer;
  }, [def.type, buzzing, runtimeActive, volume, muted]);

  // 电位器：attrs.value 变更 → analog.value 注入（运行中有效）
  const potValue = Number(part.attrs['value'] ?? 50);
  const potPowered = useMemo(() => {
    if (def.type !== 'wokwi-potentiometer') return false;
    return (
      netMap.netRoleOf(`${part.id}:VCC` as PinRef) === 'power' &&
      netMap.netRoleOf(`${part.id}:GND` as PinRef) === 'gnd'
    );
  }, [def.type, netMap, part.id]);
  // 本地 knob 显示角度（idle 状态也显示 attrs.value 映射的旋钮位置）
  const potentiometerAngle = def.type === 'wokwi-potentiometer' ? (potValue / 100) * 300 - 150 : 0;
  // 运行中 attrs.value 变化 → 注入（用 useEffect，避免每次重渲染都注入）
  useEffect(() => {
    if (def.type !== 'wokwi-potentiometer') return;
    if (!runtimeActive) return;
    const ok = setPotentiometerValue(part.id, potValue);
    // 若返回 false（未接电源）→ 不报错，Inspector 的警告由 potPowered 展示
    void ok;
  }, [def.type, part.id, potValue, runtimeActive]);

  // M8 传感器（BH1750/MPU6050/DHT22）：attrs 字段（lux/accelX/temperature/humidity…）变更 → sensor.data 注入。
  // 引擎A（wasm shim 未实现前）仅占位 log warn；引擎B 走 ws-gateway 的 DeviceSpec.defaultBytes。
  const isSensorPart =
    def.type === 'wokwi-bh1750' || def.type === 'wokwi-mpu6050' || def.type === 'wokwi-dht22';
  const sensorFields = useMemo<Record<string, number>>(() => {
    if (!isSensorPart) return {};
    const out: Record<string, number> = {};
    for (const a of def.attrs) {
      const v = Number(part.attrs[a.key] ?? a.default);
      if (Number.isFinite(v)) out[a.key] = v;
    }
    return out;
  }, [isSensorPart, def.attrs, part.attrs]);
  useEffect(() => {
    if (!isSensorPart) return;
    if (!runtimeActive) return;
    setSensorData(part.id, sensorFields);
  }, [isSensorPart, part.id, runtimeActive, sensorFields]);

  // 舵机：PWM 网络监听 → 角度换算
  const servoGpio = useMemo(
    () => (def.type === 'wokwi-servo' ? netMap.gpioOf(`${part.id}:PWM`) : null),
    [def.type, netMap, part.id],
  );
  const servoPwm = useRuntimeStore((s) =>
    servoGpio !== null ? (s.pwmDuties.get(servoGpio) ?? null) : null,
  );
  const initialAngle = Number(part.attrs['initialAngle'] ?? 90);
  const servoAngle = useMemo(() => {
    if (def.type !== 'wokwi-servo') return 0;
    if (!servoPwm) return initialAngle;
    const { duty } = servoPwm;
    // findings D3 公式：clamp(round((duty-26)/102 * 180), 0, 180)
    const deg = Math.round(((Math.max(0, Math.min(1023, duty)) - 26) / 102) * 180);
    return Math.max(0, Math.min(180, deg));
  }, [def.type, servoPwm, initialAngle]);

  // M9 SSD1306：fbFrames 位图 → offscreen canvas ImageData → Konva Image（batchDraw）
  const isOled = def.type === 'wokwi-ssd1306';
  const oledFb = useRuntimeStore((s) => (isOled ? (s.fbFrames.get(part.id) ?? null) : null));
  const oledCanvas = useMemo(() => {
    if (!isOled) return null;
    const c = document.createElement('canvas');
    c.width = SSD1306_COLS;
    c.height = 64;
    return c;
  }, [isOled]);
  const oledImgRef = useRef<Konva.Image | null>(null);
  useEffect(() => {
    if (!isOled || !oledCanvas) return;
    const ctx = oledCanvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(SSD1306_COLS, 64);
    for (let page = 0; page < 8; page++) {
      for (let col = 0; col < SSD1306_COLS; col++) {
        const byte = oledFb ? (oledFb[page * SSD1306_COLS + col] ?? 0) : 0;
        for (let bit = 0; bit < 8; bit++) {
          const on = (byte >> bit) & 1;
          const idx = ((page * 8 + bit) * SSD1306_COLS + col) * 4;
          /* 亮 = SSD1306 白蓝色；灭 = 透明（露出暗底） */
          img.data[idx] = 224;
          img.data[idx + 1] = 232;
          img.data[idx + 2] = 240;
          img.data[idx + 3] = on ? 255 : 0;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    oledImgRef.current?.getLayer()?.batchDraw();
  }, [isOled, oledCanvas, oledFb]);

  // M9 NeoPixel 灯带：neopixelFrames RGB 字节 → 灯珠颜色（灭 = rgb(0,0,0)）
  const isStrip = def.type === 'wokwi-led-strip';
  const pixelCount = Math.max(1, Math.round(Number(part.attrs['pixels'] ?? 8) || 8));
  const stripPixels = useRuntimeStore((s) =>
    isStrip ? (s.neopixelFrames.get(part.id) ?? null) : null,
  );
  const stripColors = useMemo(() => {
    if (!isStrip) return [];
    const out: string[] = [];
    for (let i = 0; i < pixelCount; i++) {
      const r = stripPixels?.[i * 3] ?? 0;
      const g = stripPixels?.[i * 3 + 1] ?? 0;
      const b = stripPixels?.[i * 3 + 2] ?? 0;
      out.push(`rgb(${r},${g},${b})`);
    }
    return out;
  }, [isStrip, stripPixels, pixelCount]);

  // 按键/开关交互（运行中点击 → 注入；空闲 → 选择/移动）
  const interaction =
    def.type === 'wokwi-pushbutton'
      ? 'button'
      : def.type === 'wokwi-slide-switch'
        ? 'switch'
        : null;
  const [pressed, setPressed] = useState(false);
  const [switchPos, setSwitchPos] = useState<'1' | '2'>(() =>
    String(part.attrs['position'] ?? '1') === '2' ? '2' : '1',
  );

  // 全局 pointerup：指针拖出元件也松开（漏 release 会导致固件读数卡死）
  useEffect(() => {
    if (!pressed) return;
    const up = (): void => {
      releaseButton(part.id);
      setPressed(false);
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [pressed, part.id]);

  const handlePointerDown = (e: KonvaE): void => {
    if (e.evt.button === 2) return;
    if (runtimeActive && interaction) {
      e.cancelBubble = true; // 不进入画布移动/框选状态机
      if (interaction === 'button') {
        pressButton(part.id);
        setPressed(true);
      } else {
        const next = switchPos === '1' ? '2' : '1';
        setSwitchPos(next);
        toggleSwitch(part.id, next);
      }
      return;
    }
    onPartPointerDown(e, part.id);
  };

  const ledOn = def.type === 'wokwi-led' && ledLevel === 1 && ledGrounded;
  const ledAlpha = ledPwm ? Math.min(1, Math.max(0, ledPwm.duty / PWM_DUTY_MAX)) : 1;
  const rgbColor =
    def.type === 'wokwi-rgb-led' && rgbGrounded && (rLevel || gLevel || bLevel)
      ? `rgb(${rLevel * 224}, ${gLevel * 224}, ${bLevel * 224})`
      : null;

  const rt: RuntimeVisual = {
    ledOn,
    ledAlpha,
    rgbColor,
    pressed,
    switchPos,
    buzzing,
    potentiometerAngle,
    servoAngle,
    potWarn: def.type === 'wokwi-potentiometer' && runtimeActive && !potPowered,
    oledCanvas: isOled ? oledCanvas : null,
    oledImgRef: isOled ? oledImgRef : null,
    stripColors,
  };

  return (
    <Group
      x={part.left + w / 2}
      y={part.top + h / 2}
      offset={{ x: w / 2, y: h / 2 }}
      rotation={part.rotate}
      onPointerDown={handlePointerDown}
    >
      {/* 选中框（在旋转组内，随旋转） */}
      {selected && (
        <Rect
          x={-3}
          y={-3}
          width={w + 6}
          height={h + 6}
          cornerRadius={4}
          stroke={SELECTION_COLOR}
          dash={[6, 4]}
          strokeWidth={1.5}
          listening={false}
        />
      )}

      {/* M8：I2C/SPI 地址冲突红框（在选中框外层，冲突优先级更高） */}
      {conflict && (
        <Rect
          x={-5}
          y={-5}
          width={w + 10}
          height={h + 10}
          cornerRadius={4}
          stroke="#dc2626"
          strokeWidth={2.5}
          listening={false}
        />
      )}

      {bodyShape(part, def, rt)}

      {/* 名称标签 */}
      <Text
        x={0}
        y={h + 2}
        width={w}
        text={label}
        align="center"
        fontSize={10}
        fill={TEXT_DIM}
        listening={false}
      />

      {/* 引脚：命中半径 6px；hover 放大 1.5×（04-§6.3） */}
      {def.pins.map((pin) => {
        const ref = `${part.id}:${pin.name}`;
        const hovered = hoverPin === ref;
        return (
          <Group key={ref}>
            <Circle
              x={pin.x}
              y={pin.y}
              radius={hovered ? 6 : 4}
              fill={hovered ? PIN_HOVER : PIN_FILL}
              stroke={hovered ? PIN_HOVER : PIN_STROKE}
              strokeWidth={1.5}
              listening={false}
            />
            <Circle
              x={pin.x}
              y={pin.y}
              radius={6}
              fill="transparent"
              onPointerEnter={() => onPinHover(ref)}
              onPointerLeave={() => onPinHover(null)}
              onPointerDown={(e) => {
                e.cancelBubble = true;
                onPinPointerDown(e, ref);
              }}
            />
          </Group>
        );
      })}
    </Group>
  );
}

interface PartLayerProps {
  parts: PartInstance[];
  defs: ReadonlyMap<string, PartDefinition>;
  selectedIds: ReadonlySet<string>;
  hoverPin: string | null;
  wiringFrom: string | null;
  onPartPointerDown: (e: KonvaE, id: string) => void;
  onPinPointerDown: (e: KonvaE, pinRef: string) => void;
  onPinHover: (pinRef: string | null) => void;
}

export function PartLayer(props: PartLayerProps) {
  const doc = useCircuitStore((s) => s.doc);
  const conflictPartIds = useCircuitStore((s) => s.conflictPartIds);
  const status = useSimStore((s) => s.status);
  // 网络映射随电路重建（M5 元件运行时：gpioOf/netRoleOf + 注入信号脚选择共用）
  const netMap = useMemo(() => buildNetMap(doc, P1_CATALOG), [doc]);
  const runtimeActive = status === 'running' || status === 'paused';

  return (
    <Group>
      {props.parts.map((p) => {
        const def = props.defs.get(p.type);
        if (!def) return null;
        return (
          <PartView
            key={p.id}
            part={p}
            def={def}
            selected={props.selectedIds.has(p.id)}
            conflict={conflictPartIds.has(p.id)}
            hoverPin={props.hoverPin}
            wiringFrom={props.wiringFrom}
            netMap={netMap}
            runtimeActive={runtimeActive}
            onPartPointerDown={props.onPartPointerDown}
            onPinPointerDown={props.onPinPointerDown}
            onPinHover={props.onPinHover}
          />
        );
      })}
    </Group>
  );
}
