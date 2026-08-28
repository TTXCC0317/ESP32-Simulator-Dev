import type { Connection, PartInstance } from '@esp32-sim/shared';
import { Fragment } from 'react';
import { Circle, Group, Line } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { pinWorldPos, resolveWirePoints, type Vec2 } from '../circuit/wiring';
import { SELECTION_COLOR, WIRE_HEX, WIRE_WIDTH } from './theme';

/**
 * WireLayer（03-§5.1）：Connection 折线；选中时显示锚点（拐点）手柄。
 * 路径解析统一走 resolveWirePoints（v/h/* 语义，见 wiring.ts）。
 */

interface WireLayerProps {
  connections: Connection[];
  partsById: ReadonlyMap<string, PartInstance>;
  selectedId?: string;
  onSelect: (id: string) => void;
}

export function WireLayer({ connections, partsById, selectedId, onSelect }: WireLayerProps) {
  return (
    <Group>
      {connections.map((c) => {
        const [srcPartId, srcPin] = c.source.split(':') as [string, string];
        const [dstPartId, dstPin] = c.target.split(':') as [string, string];
        const sp = partsById.get(srcPartId);
        const dp = partsById.get(dstPartId);
        if (!sp || !dp) return null;
        const from = pinWorldPos(sp, srcPin);
        const to = pinWorldPos(dp, dstPin);
        if (!from || !to) return null;

        const pts: Vec2[] = resolveWirePoints(from, to, c.path);
        const flat = pts.flatMap((p) => [p.x, p.y]);
        const selected = selectedId === c.id;

        return (
          <Group key={c.id}>
            <Line
              points={flat}
              stroke={WIRE_HEX[c.color]}
              strokeWidth={WIRE_WIDTH}
              lineJoin="round"
              lineCap="round"
              hitStrokeWidth={12}
              onPointerDown={(e: KonvaEventObject<PointerEvent>) => {
                e.cancelBubble = true;
                onSelect(c.id);
              }}
            />
            {selected && (
              <Fragment key="hl">
                <Line
                  points={flat}
                  stroke={SELECTION_COLOR}
                  strokeWidth={WIRE_WIDTH + 2.5}
                  opacity={0.35}
                  lineJoin="round"
                  lineCap="round"
                  listening={false}
                />
                {pts.slice(1, -1).map((p, i) => (
                  <Circle
                    key={i}
                    x={p.x}
                    y={p.y}
                    radius={3.5}
                    fill={SELECTION_COLOR}
                    stroke="#fff"
                    strokeWidth={1}
                    listening={false}
                  />
                ))}
              </Fragment>
            )}
          </Group>
        );
      })}
    </Group>
  );
}
