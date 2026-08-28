import { useEffect, useRef, useState } from 'react';
import type { PartDefinition } from '@esp32-sim/shared';
import { useUiStore } from '../stores/ui';
import { CATEGORY_LABELS, P1_PART_DEFINITIONS } from '../circuit/catalog-data';
import { useDndStore } from '../circuit/dndStore';

/**
 * 元件库面板（04-§4）：分类分组 + 搜索过滤 + pointer 拖拽（D1：不用 HTML5 DnD）。
 * M2 客户端内置 P1 目录；M3 起改为 GET /api/parts。
 */

interface Ghost {
  type: string;
  name: string;
  x: number;
  y: number;
}

export default function LibraryPanel() {
  const collapsed = useUiStore((s) => s.libraryCollapsed);
  const toggle = useUiStore((s) => s.toggleLibrary);
  const [query, setQuery] = useState('');
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const ghostRef = useRef<Ghost | null>(null);
  ghostRef.current = ghost;

  // 拖拽跟随（window 级 pointermove，pointer capture 之外也要更新）
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = ghostRef.current;
      if (!g) return;
      g.x = e.clientX;
      g.y = e.clientY;
      useDndStore.getState().move(e.clientX, e.clientY);
      setGhost({ ...g });
    };
    const onUp = () => {
      // 落点处理由 CircuitCanvas 的 window pointerup 完成；此处仅收尾幽灵
      if (ghostRef.current) {
        useDndStore.getState().end();
        setGhost(null);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  if (collapsed) {
    // 折叠后保留 8px 拉手（04-§2）
    return (
      <button
        type="button"
        onClick={toggle}
        title="展开元件库"
        className="w-2 shrink-0 cursor-pointer border-r border-panel-border bg-panel transition-colors hover:bg-accent/30"
        aria-label="expand library"
      />
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? P1_PART_DEFINITIONS.filter(
        (d) => d.name.toLowerCase().includes(q) || d.type.toLowerCase().includes(q),
      )
    : P1_PART_DEFINITIONS;

  const groups = new Map<PartDefinition['category'], PartDefinition[]>();
  for (const d of filtered) {
    const list = groups.get(d.category) ?? [];
    list.push(d);
    groups.set(d.category, list);
  }

  const startDrag = (e: React.PointerEvent<HTMLButtonElement>, d: PartDefinition) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    useDndStore.getState().start(d.type, e.clientX, e.clientY);
    setGhost({ type: d.type, name: d.name, x: e.clientX, y: e.clientY });
  };

  return (
    <aside className="flex w-70 shrink-0 flex-col border-r border-panel-border bg-panel max-[1279px]:absolute max-[1279px]:bottom-0 max-[1279px]:left-0 max-[1279px]:top-0 max-[1279px]:z-20">
      <div className="flex h-9 items-center justify-between border-b border-panel-border px-2">
        <span className="text-xs font-semibold">元件库</span>
        <button
          type="button"
          onClick={toggle}
          title="折叠"
          className="text-text-secondary hover:text-text-primary"
          aria-label="collapse library"
        >
          ‹
        </button>
      </div>
      <div className="p-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索元件…"
          className="w-full rounded border border-panel-border bg-bg px-2 py-1.5 text-xs text-text-primary placeholder:text-text-secondary"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {[...groups.entries()].map(([cat, defs]) => (
          <div key={cat} className="mb-3">
            <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              {CATEGORY_LABELS.get(cat) ?? cat}
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {defs.map((d) => (
                <button
                  key={d.type}
                  type="button"
                  onPointerDown={(e) => startDrag(e, d)}
                  title={`拖入画布：${d.name} (${d.type})`}
                  className="flex cursor-grab flex-col items-center gap-1 rounded border border-panel-border bg-bg px-1 py-2 transition-colors hover:border-accent hover:bg-accent/10 active:cursor-grabbing"
                >
                  <span
                    className="h-6 w-6 rounded-sm border border-panel-border bg-panel"
                    aria-hidden
                  />
                  <span className="text-[10px] leading-tight text-text-primary">{d.name}</span>
                </button>
              ))}
            </div>
            {defs.length === 0 && (
              <p className="px-1 py-1 text-[10px] text-text-secondary">（无匹配元件）</p>
            )}
          </div>
        ))}
        {filtered.length === 0 && <p className="p-2 text-xs text-text-secondary">没有匹配的元件</p>}
      </div>

      {/* 拖拽幽灵（D1：pointer 跟随） */}
      {ghost && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded border border-accent bg-panel px-2 py-1 text-[10px] text-text-primary shadow-md"
          style={{ left: ghost.x, top: ghost.y }}
        >
          {ghost.name}
        </div>
      )}
    </aside>
  );
}
