import { Circle, Group, Line, Rect } from 'react-konva';
import type { Vec2 } from '../circuit/wiring';
import { ACCENT, PIN_HOVER } from './theme';

/**
 * OverlayLayer（03-§5.1）：拖拽预览、框选框、连线预览（独立重绘不影响下层）。
 * 全部 listening=false，纯视觉。
 */

interface OverlayLayerProps {
  /** 连线预览：起点固定锚 + 指针实时位置（世界坐标，已正交化） */
  wiringPreview: { from: Vec2; to: Vec2 } | null;
  /** 引脚悬停高亮（世界坐标） */
  pinHighlight: Vec2 | null;
  /** 框选矩形（世界坐标） */
  marquee: { x1: number; y1: number; x2: number; y2: number } | null;
}

export function OverlayLayer({ wiringPreview, pinHighlight, marquee }: OverlayLayerProps) {
  return (
    <Group listening={false}>
      {wiringPreview && (
        <Line
          points={[
            wiringPreview.from.x,
            wiringPreview.from.y,
            wiringPreview.to.x,
            wiringPreview.to.y,
          ]}
          stroke={ACCENT}
          strokeWidth={3}
          dash={[8, 5]}
          lineCap="round"
        />
      )}
      {pinHighlight && (
        <Circle
          x={pinHighlight.x}
          y={pinHighlight.y}
          radius={8}
          stroke={PIN_HOVER}
          strokeWidth={2}
        />
      )}
      {marquee && (
        <Rect
          x={Math.min(marquee.x1, marquee.x2)}
          y={Math.min(marquee.y1, marquee.y2)}
          width={Math.abs(marquee.x2 - marquee.x1)}
          height={Math.abs(marquee.y2 - marquee.y1)}
          fill="rgba(59,130,246,0.08)"
          stroke={ACCENT}
          strokeWidth={1}
          dash={[4, 4]}
        />
      )}
    </Group>
  );
}
