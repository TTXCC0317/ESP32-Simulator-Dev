import { Shape } from 'react-konva';

/**
 * GridLayer（03-§5.1）：20px 网格，LOD——scale < 0.5 显示点阵，否则线网。
 * 直接以屏幕空间绘制（不随世界变换），避免缩放后坐标爆炸。
 */

interface GridLayerProps {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

const GRID = 20;

export function GridLayer({ width, height, offsetX, offsetY, scale }: GridLayerProps) {
  const spacing = GRID * scale;
  if (spacing < 8) return null; // 缩太小不再绘制网格（避免密集摩尔纹）

  return (
    <Shape
      sceneFunc={(ctx, shape) => {
        ctx.beginPath();
        if (scale < 0.5) {
          // 点阵
          const startX = ((offsetX % spacing) + spacing) % spacing;
          const startY = ((offsetY % spacing) + spacing) % spacing;
          for (let x = startX; x < width; x += spacing) {
            for (let y = startY; y < height; y += spacing) {
              ctx.moveTo(x, y);
              ctx.arc(x, y, 1, 0, Math.PI * 2);
            }
          }
          ctx.setAttr('fillStyle', '#2b303c');
          ctx.fill();
        } else {
          // 线网
          const startX = ((offsetX % spacing) + spacing) % spacing;
          const startY = ((offsetY % spacing) + spacing) % spacing;
          ctx.setAttr('strokeStyle', '#20242e');
          ctx.setAttr('lineWidth', 1);
          for (let x = startX; x < width; x += spacing) {
            ctx.moveTo(Math.round(x) + 0.5, 0);
            ctx.lineTo(Math.round(x) + 0.5, height);
          }
          for (let y = startY; y < height; y += spacing) {
            ctx.moveTo(0, Math.round(y) + 0.5);
            ctx.lineTo(width, Math.round(y) + 0.5);
          }
          ctx.stroke();
        }
        ctx.fillStrokeShape(shape);
      }}
    />
  );
}
