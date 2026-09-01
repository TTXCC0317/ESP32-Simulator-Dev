import { useEffect, useState } from 'react';
import type { AttrDef, PartId, PartInstance, WireColor, WireSegment } from '@esp32-sim/shared';
import { useUiStore } from '../stores/ui';
import { useCircuitStore } from '../circuit/circuitStore';
import { P1_CATALOG } from '../circuit/catalog-data';
import { moveSegment, removeSegment, setSegmentLen, WIRE_COLOR_HEX } from '../circuit/wiring';

/**
 * Inspector 属性面板（04-§5、02-M2）：
 * - 单选元件：名称 / 位置 / 旋转 / AttrDef 动态表单（enum/number/color/boolean/text）/ 删除；
 * - 多选：批量旋转 / 批量删除；
 * - 选中连线：两端引脚 / 色板 / 锚点段列表（长度·上移·下移·删除）/ 自动布线 / 删除。
 */

export default function InspectorPanel() {
  const collapsed = useUiStore((s) => s.inspectorCollapsed);
  const toggle = useUiStore((s) => s.toggleInspector);

  if (collapsed) {
    // 折叠后保留 8px 拉手（04-§2）
    return (
      <button
        type="button"
        onClick={toggle}
        title="展开属性面板"
        className="ml-auto w-2 shrink-0 cursor-pointer border-l border-panel-border bg-panel transition-colors hover:bg-accent/30"
        aria-label="expand inspector"
      />
    );
  }

  return (
    <aside className="ml-auto flex w-70 shrink-0 flex-col border-l border-panel-border bg-panel max-[1279px]:absolute max-[1279px]:bottom-0 max-[1279px]:right-0 max-[1279px]:top-0 max-[1279px]:z-20">
      <div className="flex h-9 items-center justify-between border-b border-panel-border px-2">
        <span className="text-xs font-semibold">属性</span>
        <button
          type="button"
          onClick={toggle}
          title="折叠"
          className="text-text-secondary hover:text-text-primary"
          aria-label="collapse inspector"
        >
          ›
        </button>
      </div>
      <InspectorBody />
    </aside>
  );
}

function InspectorBody() {
  const doc = useCircuitStore((s) => s.doc);
  const selectedPartIds = useCircuitStore((s) => s.selectedPartIds);
  const selectedConnectionId = useCircuitStore((s) => s.selectedConnectionId);

  if (selectedConnectionId) {
    const conn = doc.connections.find((c) => c.id === selectedConnectionId);
    if (conn) return <ConnectionInspector connId={conn.id} />;
  }

  const parts = doc.parts.filter((p) => selectedPartIds.includes(p.id));
  const single = parts.length === 1 ? parts[0] : undefined;
  if (single) return <PartInspector part={single} />;
  if (parts.length > 1) return <MultiPartInspector partIds={parts.map((p) => p.id)} />;

  return (
    <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-text-secondary">
      点击画布中的元件或连线查看属性
    </div>
  );
}

// ---- 元件属性 ----

function PartInspector({ part }: { part: PartInstance }) {
  const def = P1_CATALOG.get(part.type);
  const error = useCircuitStore((s) => s.error);
  const conflictPartIds = useCircuitStore((s) => s.conflictPartIds);
  if (!def) {
    return <div className="p-3 text-xs text-danger">未知元件类型: {part.type}</div>;
  }
  const isBoard = part.type.startsWith('board-');
  const hasConflict = conflictPartIds.has(part.id);

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-3">
      <div>
        <p className="text-sm font-semibold text-text-primary">{def.name}</p>
        <p className="font-mono text-[10px] text-text-secondary">
          {part.id} · {part.type}
        </p>
      </div>

      {/* M8：I2C/SPI 地址冲突专用提示（优先级高于通用 error） */}
      {hasConflict && (
        <p
          className="rounded border border-danger bg-danger/15 px-2 py-1.5 text-xs text-danger"
          role="alert"
        >
          ⚠ 地址冲突：与其他元件共享相同 I2C 地址或 SPI CS 引脚，请检查画布上带红框的元件。
        </p>
      )}

      {error && !hasConflict && (
        <p className="rounded bg-danger/15 px-2 py-1 text-xs text-danger" role="alert">
          {error}
        </p>
      )}

      <PositionField partId={part.id} left={part.left} top={part.top} />

      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary">旋转</span>
        <div className="flex items-center gap-1.5">
          <span className="w-8 text-right text-xs text-text-primary">{part.rotate}°</span>
          <button
            type="button"
            onClick={() => useCircuitStore.getState().rotatePart(part.id)}
            title="旋转 90°（快捷键 R）"
            className="rounded border border-panel-border bg-bg px-2 py-0.5 text-xs text-text-primary hover:border-accent"
          >
            +90°
          </button>
        </div>
      </div>

      {def.attrs.length > 0 && (
        <div className="space-y-2 border-t border-panel-border pt-2">
          {def.attrs.map((a) => (
            <AttrField key={a.key} partId={part.id} def={a} value={part.attrs[a.key]} />
          ))}
        </div>
      )}

      <div className="border-t border-panel-border pt-2">
        <p className="mb-1 text-[10px] uppercase tracking-wider text-text-secondary">引脚</p>
        <div className="flex flex-wrap gap-1">
          {Array.from(new Set(def.pins.map((p) => p.name))).map((name) => (
            <span
              key={name}
              className="rounded bg-panel-border/50 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
            >
              {name}
            </span>
          ))}
        </div>
      </div>

      {!isBoard && (
        <button
          type="button"
          onClick={() => useCircuitStore.getState().removePart(part.id)}
          className="w-full rounded border border-danger/50 bg-danger/10 px-2 py-1.5 text-xs text-danger hover:bg-danger/20"
        >
          删除元件（Del）
        </button>
      )}
    </div>
  );
}

/** 位置输入：本地编辑态，blur/Enter 提交（movePart 内部做 20px 网格吸附） */
function PositionField({ partId, left, top }: { partId: PartId; left: number; top: number }) {
  const commit = (x: number, y: number) => useCircuitStore.getState().movePart(partId, { x, y });
  return (
    <div className="flex items-center gap-2">
      <NumberInput label="X" value={left} onCommit={(v) => commit(v, top)} />
      <NumberInput label="Y" value={top} onCommit={(v) => commit(left, v)} />
    </div>
  );
}

/** 可复用数字输入：受控草稿，失焦/回车提交；非法值回落当前值 */
function NumberInput(props: {
  label?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  testId?: string;
  onCommit: (v: number) => void;
}) {
  const { label, value, min, max, step, testId, onCommit } = props;
  const [draft, setDraft] = useState(String(value));
  // 外部值变化（撤销/画布拖动）时同步草稿
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n)) onCommit(n);
    else setDraft(String(value));
  };

  return (
    <label className="flex flex-1 items-center gap-1 text-xs text-text-secondary">
      {label && <span className="w-4">{label}</span>}
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step ?? 1}
        data-testid={testId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className="w-full min-w-0 rounded border border-panel-border bg-bg px-1.5 py-1 text-xs text-text-primary"
      />
    </label>
  );
}

/** AttrDef → 控件（04-§5：enum→下拉 / number→步进 / color→色板 / boolean→开关 / text→文本） */
function AttrField({
  partId,
  def,
  value,
}: {
  partId: PartId;
  def: AttrDef;
  value: string | number | boolean | undefined;
}) {
  const update = (v: string | number | boolean) =>
    useCircuitStore.getState().updateAttr(partId, def.key, v);

  const control = (() => {
    switch (def.type) {
      case 'enum': {
        const cur = String(value ?? def.default);
        return (
          <select
            value={cur}
            onChange={(e) => update(e.target.value)}
            data-testid={`attr-${def.key}`}
            className="w-full rounded border border-panel-border bg-bg px-1.5 py-1 text-xs text-text-primary"
          >
            {(def.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      }
      case 'number':
        return (
          <NumberInput
            value={typeof value === 'number' ? value : Number(def.default)}
            min={def.min}
            max={def.max}
            step={def.step}
            testId={`attr-${def.key}`}
            onCommit={update}
          />
        );
      case 'color':
        return (
          <input
            type="color"
            value={typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#ff0000'}
            onChange={(e) => update(e.target.value)}
            data-testid={`attr-${def.key}`}
            className="h-7 w-full cursor-pointer rounded border border-panel-border bg-bg"
          />
        );
      case 'boolean':
        return (
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(value ?? def.default)}
            data-testid={`attr-${def.key}`}
            onClick={() => update(!(value ?? def.default))}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              (value ?? def.default) ? 'bg-accent' : 'bg-panel-border'
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                (value ?? def.default) ? 'left-[18px]' : 'left-0.5'
              }`}
            />
          </button>
        );
      case 'text':
      default:
        return (
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(e) => update(e.target.value)}
            data-testid={`attr-${def.key}`}
            className="w-full rounded border border-panel-border bg-bg px-1.5 py-1 text-xs text-text-primary"
          />
        );
    }
  })();

  return (
    <label className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-xs text-text-secondary">{def.label}</span>
      <div className="flex min-w-0 flex-1 justify-end">{control}</div>
    </label>
  );
}

function MultiPartInspector({ partIds }: { partIds: PartId[] }) {
  return (
    <div className="flex-1 space-y-3 p-3">
      <p className="text-sm text-text-primary">已选 {partIds.length} 个元件</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            for (const id of partIds) useCircuitStore.getState().rotatePart(id);
          }}
          className="flex-1 rounded border border-panel-border bg-bg px-2 py-1.5 text-xs text-text-primary hover:border-accent"
        >
          批量旋转 90°
        </button>
        <button
          type="button"
          onClick={() => {
            for (const id of partIds) useCircuitStore.getState().removePart(id);
          }}
          className="flex-1 rounded border border-danger/50 bg-danger/10 px-2 py-1.5 text-xs text-danger hover:bg-danger/20"
        >
          删除（Del）
        </button>
      </div>
      <p className="text-[10px] text-text-secondary">属性编辑请单选元件</p>
    </div>
  );
}

// ---- 连线属性 ----

function ConnectionInspector({ connId }: { connId: string }) {
  const doc = useCircuitStore((s) => s.doc);
  const conn = doc.connections.find((c) => c.id === connId);
  const error = useCircuitStore((s) => s.error);
  if (!conn) return null;
  const st = useCircuitStore.getState();

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-3">
      <p className="text-sm font-semibold text-text-primary">连线</p>
      <p className="font-mono text-[10px] leading-relaxed text-text-secondary">
        {conn.source}
        <br />→ {conn.target}
      </p>

      {error && (
        <p className="rounded bg-danger/15 px-2 py-1 text-xs text-danger" role="alert">
          {error}
        </p>
      )}

      {/* 色板（04-§5） */}
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wider text-text-secondary">颜色</p>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="线色">
          {(Object.entries(WIRE_COLOR_HEX) as Array<[WireColor, string]>).map(([name, hex]) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={conn.color === name}
              title={name}
              onClick={() => st.setConnectionColor(conn.id, name)}
              data-testid={`wire-color-${name}`}
              className={`h-6 w-6 rounded-full border-2 ${
                conn.color === name ? 'border-accent' : 'border-transparent'
              }`}
              style={{ backgroundColor: hex }}
            />
          ))}
        </div>
      </div>

      <AnchorList connId={conn.id} path={conn.path} />

      <div className="flex gap-2 border-t border-panel-border pt-2">
        <button
          type="button"
          onClick={() => st.updateWirePath(conn.id, [])}
          title="清空锚点，恢复自动正交布线"
          className="flex-1 rounded border border-panel-border bg-bg px-2 py-1.5 text-xs text-text-primary hover:border-accent"
        >
          自动布线
        </button>
        <button
          type="button"
          onClick={() => st.removeConnection(conn.id)}
          className="flex-1 rounded border border-danger/50 bg-danger/10 px-2 py-1.5 text-xs text-danger hover:bg-danger/20"
        >
          删除连线（Del）
        </button>
      </div>
    </div>
  );
}

/** 锚点段列表（04-§5：长度调整 / 上移 / 下移 / 删除） */
function AnchorList({ connId, path }: { connId: string; path: WireSegment[] }) {
  const st = useCircuitStore.getState();
  const commit = (next: WireSegment[]) => st.updateWirePath(connId, next);

  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wider text-text-secondary">
        锚点段（{path.length}）
      </p>
      {path.length === 0 && <p className="text-xs text-text-secondary">自动布线（v-then-h）</p>}
      <div className="space-y-1">
        {path.map((seg, i) => (
          <div key={i} className="flex items-center gap-1" data-testid={`anchor-${i}`}>
            <span className="w-4 font-mono text-xs text-text-primary">
              {seg.dir === '*' ? '＊' : seg.dir.toUpperCase()}
            </span>
            {seg.dir === '*' ? (
              <span className="flex-1 text-xs text-text-secondary">自动接续</span>
            ) : (
              <NumberInput
                value={seg.len}
                step={10}
                onCommit={(v) => commit(setSegmentLen(path, i, v))}
              />
            )}
            <button
              type="button"
              title="上移"
              onClick={() => commit(moveSegment(path, i, -1))}
              className="rounded px-1 text-xs text-text-secondary hover:text-text-primary"
            >
              ↑
            </button>
            <button
              type="button"
              title="下移"
              onClick={() => commit(moveSegment(path, i, 1))}
              className="rounded px-1 text-xs text-text-secondary hover:text-text-primary"
            >
              ↓
            </button>
            <button
              type="button"
              title="删除此段"
              onClick={() => commit(removeSegment(path, i))}
              className="rounded px-1 text-xs text-danger hover:text-danger"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
