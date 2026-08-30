import { useErrorsStore } from '../stores/errors';

/**
 * 问题面板（04-§9 错误面板，M6）：BottomPanel 第 5 个 Tab。
 * 聚合 build（编译 critical 行）/ engine（运行时）/ session（WS 会话）三类问题；
 * error 级未读数由 BottomPanel 渲染红点角标并自动弹出（04-§9）。
 */

const SOURCE_LABEL: Record<string, string> = {
  build: '编译',
  engine: '运行时',
  session: '会话',
};

function timeOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function ProblemsTab() {
  const items = useErrorsStore((s) => s.items);
  const clear = useErrorsStore((s) => s.clear);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-panel-border px-3 py-1.5">
        <span className="text-xs text-text-secondary">
          {items.length === 0 ? '无问题' : `${items.length} 条`}
        </span>
        {items.length > 0 && (
          <button
            type="button"
            onClick={clear}
            className="ml-auto rounded px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary"
          >
            清空
          </button>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-3 py-1 font-mono text-xs leading-5">
        {items.map((it) => (
          <li key={it.id} className="flex gap-2 py-0.5">
            <span
              className={it.severity === 'error' ? 'text-red-500' : 'text-amber-500'}
              title={it.severity === 'error' ? '错误' : '警告'}
            >
              ●
            </span>
            <span className="shrink-0 text-text-secondary">{timeOf(it.ts)}</span>
            <span className="shrink-0 text-text-secondary">[{SOURCE_LABEL[it.source]}]</span>
            <span className="min-w-0 flex-1 break-all text-text-primary">
              {it.title}
              {it.detail && <span className="text-text-secondary"> — {it.detail}</span>}
              {it.file !== undefined && (
                <span className="text-accent">
                  {' '}
                  {it.file}
                  {it.line !== undefined ? `:${it.line}` : ''}
                  {it.col !== undefined ? `:${it.col}` : ''}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
