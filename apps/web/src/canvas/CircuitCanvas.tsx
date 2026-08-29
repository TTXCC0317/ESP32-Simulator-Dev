import { useEffect, useRef, useState } from 'react';
import { Stage, Layer } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Stage as KonvaStage } from 'konva/lib/Stage';
import type { Connection } from '@esp32-sim/shared';
import { useCircuitStore } from '../circuit/circuitStore';
import { P1_CATALOG } from '../circuit/catalog-data';
import { pinWorldPos, snapPoint, type Vec2 } from '../circuit/wiring';
import { useDndStore } from '../circuit/dndStore';
import { useUiStore } from '../stores/ui';
import { GridLayer } from './GridLayer';
import { WireLayer } from './WireLayer';
import { PartLayer } from './PartLayer';
import { OverlayLayer } from './OverlayLayer';
import { clampScale, fitContent, resetZoom, toWorld, zoomAt, type Viewport } from './viewport';

/**
 * 画布容器与指针状态机（03-§5、04-§6.1）：
 * idle / panning(Space+左键 或 中键) / moving / marquee / wiring；
 * 滚轮以指针为中心缩放 0.25–4x；Ctrl+0 复位、Ctrl+1 适应窗口。
 */

type Mode = 'idle' | 'panning' | 'moving' | 'marquee' | 'wiring';

interface PartSnap {
  id: string;
  left: number;
  top: number;
}

interface WiringState {
  fromRef: string;
  fromPos: Vec2;
}

export default function CircuitCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<KonvaStage>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [viewport, setViewport] = useState<Viewport>({ scale: 1, x: 0, y: 0 });
  const [hoverPin, setHoverPin] = useState<string | null>(null);
  const [wiring, setWiring] = useState<WiringState | null>(null);
  const [wiringPreviewTo, setWiringPreviewTo] = useState<Vec2 | null>(null);
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  );

  const modeRef = useRef<Mode>('idle');
  const spaceDownRef = useRef(false);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const hoverPinRef = useRef<string | null>(null);
  hoverPinRef.current = hoverPin;

  const panStartRef = useRef<{ client: Vec2; vp: Viewport } | null>(null);
  const moveStartRef = useRef<{ world: Vec2; parts: PartSnap[] } | null>(null);
  const marqueeStartRef = useRef<Vec2 | null>(null);
  const prevSelectionRef = useRef<string[]>([]);

  const doc = useCircuitStore((s) => s.doc);
  const selectedPartIds = useCircuitStore((s) => s.selectedPartIds);
  const selectedConnectionId = useCircuitStore((s) => s.selectedConnectionId);
  const error = useCircuitStore((s) => s.error);

  // 容器尺寸
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // 缩略图截图钩子（04-§8 D3）：保存工程前生成 240×160 PNG dataURL（不展示 Overlay 高亮）
  useEffect(() => {
    const capture = (): string | null => {
      const stage = stageRef.current;
      if (!stage) return null;
      const src = stage.toCanvas({ pixelRatio: 0.5 });
      const out = document.createElement('canvas');
      out.width = 240;
      out.height = 160;
      const ctx = out.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle =
        getComputedStyle(document.documentElement).getPropertyValue('--bg') || '#0f1115';
      ctx.fillRect(0, 0, 240, 160);
      const scale = Math.max(240 / src.width, 160 / src.height);
      const w = src.width * scale;
      const h = src.height * scale;
      ctx.drawImage(src, (240 - w) / 2, (160 - h) / 2, w, h);
      return out.toDataURL('image/png');
    };
    useUiStore.getState().setStageCapture(capture);
    return () => {
      useUiStore.getState().setStageCapture(null);
    };
  }, []);

  // 光标
  const cursor =
    modeRef.current === 'wiring' || hoverPin
      ? 'crosshair'
      : modeRef.current === 'panning'
        ? 'grabbing'
        : 'default';
  useEffect(() => {
    const c = stageRef.current?.container();
    if (c) c.style.cursor = cursor;
  }, [cursor, hoverPin, wiring]);

  // 键盘：Space 平移 / Esc / Delete / R / Ctrl+0 / Ctrl+1（04-§6.2）
  useEffect(() => {
    const isEditable = (t: EventTarget | null) =>
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      const s = useCircuitStore.getState();
      if (e.code === 'Space') {
        spaceDownRef.current = true;
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        modeRef.current = 'idle';
        setWiring(null);
        setWiringPreviewTo(null);
        setMarquee(null);
        s.clearSelection();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (s.selectedConnectionId) {
          s.removeConnection(s.selectedConnectionId);
        } else if (s.selectedPartIds.length > 0) {
          for (const id of s.selectedPartIds) s.removePart(id);
        }
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        for (const id of s.selectedPartIds) s.rotatePart(id);
        return;
      }
      if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        const el = containerRef.current;
        if (el) {
          setViewport((vp) => resetZoom(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 }));
        }
        return;
      }
      if (e.ctrlKey && e.key === '1') {
        e.preventDefault();
        fitAll();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDownRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // 适应窗口
  const fitAll = () => {
    const el = containerRef.current;
    if (!el) return;
    const parts = useCircuitStore.getState().doc.parts;
    if (parts.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of parts) {
      const def = P1_CATALOG.get(p.type);
      if (!def) continue;
      const w = p.rotate % 180 === 90 ? def.renderer.height : def.renderer.width;
      const h = p.rotate % 180 === 90 ? def.renderer.width : def.renderer.height;
      minX = Math.min(minX, p.left);
      minY = Math.min(minY, p.top);
      maxX = Math.max(maxX, p.left + w);
      maxY = Math.max(maxY, p.top + h);
    }
    setViewport(
      fitContent(
        { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        {
          width: el.clientWidth,
          height: el.clientHeight,
        },
      ),
    );
  };

  // 元件库拖放落点（04-§4 D1：pointerup 命中画布 → addPart）
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      const dropped = useDndStore.getState().end();
      if (!dropped) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (!inside) return; // 拖回面板取消
      const world = toWorld(viewportRef.current, {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      useCircuitStore.getState().addPart(dropped.type, world);
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, []);

  // 错误提示 3s 自动消失
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => useCircuitStore.setState({ error: undefined }), 3000);
    return () => clearTimeout(t);
  }, [error]);

  // ---- 指针事件（04-§6.1 状态机） ----

  const getStagePos = (): Vec2 => {
    const st = stageRef.current?.getPointerPosition();
    return st ?? { x: 0, y: 0 };
  };

  const onStagePointerDown = (e: KonvaEventObject<PointerEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;
    if (e.evt.button === 2) return; // 右键忽略
    stage.setPointerCapture(e.evt.pointerId);
    const client = getStagePos();

    if (spaceDownRef.current || e.evt.button === 1) {
      modeRef.current = 'panning';
      panStartRef.current = { client, vp: viewportRef.current };
      return;
    }
    // 空白处：进入框选并清空选择
    modeRef.current = 'marquee';
    const world = toWorld(viewportRef.current, client);
    marqueeStartRef.current = world;
    prevSelectionRef.current = e.evt.shiftKey ? useCircuitStore.getState().selectedPartIds : [];
    setMarquee({ x1: world.x, y1: world.y, x2: world.x, y2: world.y });
    useCircuitStore.getState().clearSelection();
  };

  const onStagePointerMove = (_e: KonvaEventObject<PointerEvent>) => {
    const mode = modeRef.current;
    if (mode === 'idle') return;
    const client = getStagePos();
    const world = toWorld(viewportRef.current, client);
    const s = useCircuitStore.getState();

    switch (mode) {
      case 'panning': {
        const start = panStartRef.current;
        if (!start) return;
        setViewport({
          ...start.vp,
          x: start.vp.x + (client.x - start.client.x),
          y: start.vp.y + (client.y - start.client.y),
        });
        break;
      }
      case 'marquee': {
        const st = marqueeStartRef.current;
        if (st) setMarquee({ x1: st.x, y1: st.y, x2: world.x, y2: world.y });
        break;
      }
      case 'moving': {
        const start = moveStartRef.current;
        if (!start) return;
        const dx = world.x - start.world.x;
        const dy = world.y - start.world.y;
        for (const p of start.parts) {
          s.movePart(p.id, { x: p.left + dx, y: p.top + dy });
        }
        break;
      }
      case 'wiring': {
        const hover = hoverPinRef.current;
        const hoverPos = hover ? pinRefPos(hover) : null;
        setWiringPreviewTo(hoverPos ?? snapPoint(world));
        break;
      }
    }
  };

  const onStagePointerUp = (e: KonvaEventObject<PointerEvent>) => {
    const mode = modeRef.current;
    const s = useCircuitStore.getState();
    switch (mode) {
      case 'panning':
        panStartRef.current = null;
        break;
      case 'marquee': {
        const m = marquee;
        const st = marqueeStartRef.current;
        if (m && st) {
          const world = toWorld(viewportRef.current, getStagePos());
          const rect = {
            x1: Math.min(st.x, world.x),
            y1: Math.min(st.y, world.y),
            x2: Math.max(st.x, world.x),
            y2: Math.max(st.y, world.y),
          };
          const big = rect.x2 - rect.x1 > 4 || rect.y2 - rect.y1 > 4;
          if (big) {
            const hits = s.doc.parts.filter((p) => {
              const def = P1_CATALOG.get(p.type);
              if (!def) return false;
              const w = p.rotate % 180 === 90 ? def.renderer.height : def.renderer.width;
              const h = p.rotate % 180 === 90 ? def.renderer.width : def.renderer.height;
              return (
                p.left < rect.x2 && p.left + w > rect.x1 && p.top < rect.y2 && p.top + h > rect.y1
              );
            });
            const ids = hits.map((p) => p.id);
            const merged = [...new Set([...prevSelectionRef.current, ...ids])];
            s.selectPart(undefined);
            for (const id of merged) s.selectPart(id, true);
          }
        }
        setMarquee(null);
        marqueeStartRef.current = null;
        break;
      }
      case 'moving':
        moveStartRef.current = null;
        break;
      case 'wiring': {
        const w = wiring;
        const hover = hoverPinRef.current;
        if (w && hover && hover !== w.fromRef) {
          s.addConnection(w.fromRef, hover);
        }
        // Esc / 落空 / 落回源引脚 = 取消（04-§6.3）
        setWiring(null);
        setWiringPreviewTo(null);
        break;
      }
    }
    if (modeRef.current !== 'wiring') modeRef.current = 'idle';
    void e;
  };

  const onPartPointerDown = (e: KonvaEventObject<PointerEvent>, id: string) => {
    if (e.evt.button === 2) return;
    const stage = stageRef.current;
    if (stage) stage.setPointerCapture(e.evt.pointerId);
    const s = useCircuitStore.getState();
    s.selectPart(id, e.evt.shiftKey);
    const ids = e.evt.shiftKey ? [...new Set([...s.selectedPartIds, id])] : [id];
    const world = toWorld(viewportRef.current, getStagePos());
    const snaps: PartSnap[] = [];
    for (const pid of ids) {
      const p = s.doc.parts.find((x) => x.id === pid);
      if (p) snaps.push({ id: pid, left: p.left, top: p.top });
    }
    moveStartRef.current = { world, parts: snaps };
    modeRef.current = 'moving';
  };

  const onPinPointerDown = (e: KonvaEventObject<PointerEvent>, pinRef: string) => {
    if (e.evt.button === 2) return;
    const stage = stageRef.current;
    if (stage) stage.setPointerCapture(e.evt.pointerId);
    const pos = pinRefPos(pinRef);
    if (!pos) return;
    modeRef.current = 'wiring';
    setWiring({ fromRef: pinRef, fromPos: pos });
    setWiringPreviewTo(pos);
  };

  const onPinHover = (pinRef: string | null) => {
    setHoverPin(pinRef);
  };

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    const pos = stage?.getPointerPosition();
    if (!pos) return;
    const factor = e.evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    setViewport((vp) => zoomAt(vp, pos, factor));
  };

  // partsById 查找表
  const partsById = new Map(doc.parts.map((p) => [p.id, p]));
  const selectedSet = new Set(selectedPartIds);

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1 overflow-hidden bg-canvas">
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.evt.preventDefault()}
      >
        {/* GridLayer：屏幕空间网格，不随世界变换 */}
        <Layer listening={false}>
          <GridLayer
            width={size.width}
            height={size.height}
            offsetX={viewport.x}
            offsetY={viewport.y}
            scale={viewport.scale}
          />
        </Layer>
        <Layer x={viewport.x} y={viewport.y} scaleX={viewport.scale} scaleY={viewport.scale}>
          <WireLayer
            connections={doc.connections}
            partsById={partsById}
            selectedId={selectedConnectionId}
            onSelect={(id) => useCircuitStore.getState().selectConnection(id)}
          />
          <PartLayer
            parts={doc.parts}
            defs={P1_CATALOG}
            selectedIds={selectedSet}
            hoverPin={hoverPin}
            wiringFrom={wiring?.fromRef ?? null}
            onPartPointerDown={onPartPointerDown}
            onPinPointerDown={onPinPointerDown}
            onPinHover={onPinHover}
          />
          <OverlayLayer
            wiringPreview={
              wiring && wiringPreviewTo ? { from: wiring.fromPos, to: wiringPreviewTo } : null
            }
            pinHighlight={hoverPin ? pinRefPos(hoverPin) : null}
            marquee={marquee}
          />
        </Layer>
      </Stage>

      {/* 空态引导（04-§12）：画布仅有板卡时提示 */}
      {doc.parts.length <= 1 && !wiring && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="rounded-lg border border-panel-border bg-panel/90 px-6 py-5 text-center shadow-sm">
            <p className="text-sm text-text-primary">从左侧元件库拖入元件开始搭建</p>
            <p className="mt-1 text-xs text-text-secondary">
              拖引脚到另一引脚连线 · 滚轮缩放 · Space/中键平移 · R 旋转 · Del 删除
            </p>
          </div>
        </div>
      )}

      {/* 缩放指示 / 操作错误提示 */}
      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-col gap-1 text-[10px] text-text-secondary">
        <span className="rounded bg-panel/80 px-1.5 py-0.5">
          {Math.round(viewport.scale * 100)}%
        </span>
        {error && (
          <span className="rounded bg-danger/90 px-2 py-1 text-xs text-white">{error}</span>
        )}
      </div>

      <StressHelper />
    </div>
  );
}

function pinRefPos(ref: string): Vec2 | null {
  const [partId, pin] = ref.split(':') as [string, string];
  const part = useCircuitStore.getState().doc.parts.find((p) => p.id === partId);
  if (!part) return null;
  return pinWorldPos(part, pin);
}

/** 开发期压测辅助（验收：100 元件/150 连线 ≥30fps）；生产构建不注入 */
function StressHelper() {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __stress?: (n?: number, wires?: number) => void };
    w.__stress = (n = 100, wires = 150) => {
      const parts = [];
      for (let i = 0; i < n; i++) {
        parts.push({
          id: `st${i}`,
          type: i % 2 === 0 ? 'wokwi-led' : 'wokwi-resistor',
          left: 340 + (i % 10) * 60,
          top: 40 + Math.floor(i / 10) * 90,
          rotate: 0 as const,
          attrs: {},
        });
      }
      const conns: Connection[] = [];
      for (let i = 0; i < wires; i++) {
        const target = parts[i % n];
        if (!target) continue;
        conns.push({
          id: `sw${i}`,
          source: 'esp:GPIO4',
          target: `${target.id}:${target.type === 'wokwi-led' ? 'A' : '1'}`,
          color: 'blue' as const,
          path: [],
        });
      }
      const doc = useCircuitStore.getState().doc;
      useCircuitStore.getState().replaceDoc({
        ...doc,
        parts: [...doc.parts, ...parts],
        connections: conns,
      });
    };
    return () => {
      delete w.__stress;
    };
  }, []);
  return null;
}

// clampScale 目前仅 viewport.ts 内部使用，保留导出防摇tree
void clampScale;
