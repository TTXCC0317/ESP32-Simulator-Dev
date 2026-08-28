import { useUiStore } from '../stores/ui';

/** Inspector 属性面板骨架（04-§5；属性表单随 M2/M3 接 AttrDef） */
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
      <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-text-secondary">
        点击画布中的元件查看属性
      </div>
    </aside>
  );
}
