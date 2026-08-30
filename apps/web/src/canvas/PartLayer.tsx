import { Fragment, useEffect, useMemo, useState } from 'react';
import type { PartDefinition, PartInstance } from '@esp32-sim/shared';
import { Circle, Ellipse, Group, Line, Rect, Text } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useCircuitStore } from '../circuit/circuitStore';
import { P1_CATALOG } from '../circuit/catalog-data';
import { useSimStore } from '../stores/sim';
import { useRuntimeStore } from '../stores/runtime';
import { useUiStore } from '../stores/ui';
import { startBuzzer, stopBuzzer } from '../audio/buzzer';
import { pressButton, releaseButton, toggleSwitch } from '../sim/part-input';
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

/** 元件运行时视觉状态（bodyShape 渲染入参；M5） */
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
}

interface PartViewProps {
  part: PartInstance;
  def: PartDefinition;
  selected: boolean;
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
            stroke={PART_STROKE}
            strokeWidth={2}
          />
          <Circle x={48} y={42} radius={22} fill={PART_BODY} stroke={PART_STROKE} strokeWidth={2} />
          <Line points={[48, 42, 48, 24]} stroke={TEXT_DIM} strokeWidth={3} listening={false} />
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

  const rt: RuntimeVisual = { ledOn, ledAlpha, rgbColor, pressed, switchPos, buzzing };

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
