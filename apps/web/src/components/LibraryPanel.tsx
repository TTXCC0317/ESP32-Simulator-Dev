import { useUiStore } from '../stores/ui';

/** Library 元件库面板骨架（04-§4；搜索/分类树/卡片数据随 M3 接 /api/parts） */
export default function LibraryPanel() {
  const collapsed = useUiStore((s) => s.libraryCollapsed);
  const toggle = useUiStore((s) => s.toggleLibrary);

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
          placeholder="搜索元件（M3 接入）"
          disabled
          className="w-full rounded border border-panel-border bg-bg px-2 py-1.5 text-xs text-text-primary placeholder:text-text-secondary opacity-60"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2 text-xs text-text-secondary">
        <p className="mb-2 text-text-primary">分类（M3 接入）</p>
        {['开发板', '基础IO', '传感器', '显示', '电源'].map((c) => (
          <div
            key={c}
            className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-accent/10"
          >
            <span>{c}</span>
            <span className="rounded-full bg-panel-border px-1.5 text-[10px]">0</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
