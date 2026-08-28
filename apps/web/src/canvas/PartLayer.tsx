import { Fragment } from 'react';
import type { PartDefinition, PartInstance } from '@esp32-sim/shared';
import { Circle, Ellipse, Group, Line, Rect, Text } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
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
 */

type KonvaE = KonvaEventObject<PointerEvent>;

interface PartViewProps {
  part: PartInstance;
  def: PartDefinition;
  selected: boolean;
  hoverPin: string | null;
  wiringFrom: string | null;
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

function bodyShape(part: PartInstance, def: PartDefinition) {
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
          <Ellipse
            x={20}
            y={32}
            radiusX={14}
            radiusY={18}
            fill={c}
            opacity={0.35}
            stroke={c}
            strokeWidth={2}
          />
          <Ellipse
            x={20}
            y={32}
            radiusX={7}
            radiusY={9}
            fill={c}
            opacity={0.55}
            listening={false}
          />
        </Fragment>
      );
    }
    case 'wokwi-rgb-led':
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
          <Ellipse
            x={24}
            y={40}
            radiusX={15}
            radiusY={16}
            fill="#e8eaf0"
            opacity={0.25}
            stroke="#e8eaf0"
            strokeWidth={2}
          />
        </Fragment>
      );
    case 'wokwi-pushbutton': {
      const c = ATTR_COLORS[String(part.attrs['color'] ?? 'red')] ?? '#e5484d';
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
          <Circle x={34} y={39} radius={12} fill={c} opacity={0.85} />
          <Circle
            x={34}
            y={39}
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
      const pos = String(part.attrs['position'] ?? '1');
      const knobX = pos === '2' ? 58 : 22;
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
  const { part, def, selected, hoverPin, onPartPointerDown, onPinPointerDown, onPinHover } = props;
  const { width: w, height: h } = def.renderer;
  const label = String(part.attrs['label'] ?? '') || def.name;

  return (
    <Group
      x={part.left + w / 2}
      y={part.top + h / 2}
      offset={{ x: w / 2, y: h / 2 }}
      rotation={part.rotate}
      onPointerDown={(e) => onPartPointerDown(e, part.id)}
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

      {bodyShape(part, def)}

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
            onPartPointerDown={props.onPartPointerDown}
            onPinPointerDown={props.onPinPointerDown}
            onPinHover={props.onPinHover}
          />
        );
      })}
    </Group>
  );
}
