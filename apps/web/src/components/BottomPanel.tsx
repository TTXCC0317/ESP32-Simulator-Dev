import { useEffect, useRef, useState } from 'react';
import { useErrorsStore } from '../stores/errors';
import { useUiStore } from '../stores/ui';
import DiagramTab from './DiagramTab';
import ProblemsTab from './ProblemsTab';
import SerialMonitorTab from './SerialMonitorTab';

const TABS = ['代码', 'diagram.json', '串口监视器', '逻辑分析仪', '问题'] as const;
type Tab = (typeof TABS)[number];

/**
 * BottomPanel（04-§2/§7）：Tab 条 + 默认 260px，可拖 180–480px，可折叠。
 * M2 接入 diagram.json Tab；代码编辑器（Monaco）待排期（04-§7.1，M3 实际交付为工程管理）、
 * 串口 M4 已接、逻辑分析仪随 M11、问题面板 M6 已接（04-§9：error 级红点角标 + 自动弹出）。
 */
export default function BottomPanel() {
  const collapsed = useUiStore((s) => s.bottomCollapsed);
  const toggleBottom = useUiStore((s) => s.toggleBottom);
  const height = useUiStore((s) => s.bottomHeight);
  const setHeight = useUiStore((s) => s.setBottomHeight);
  const [active, setActive] = useState<Tab>('diagram.json');
  const unread = useErrorsStore((s) => s.unread);
  const markRead = useErrorsStore((s) => s.markRead);
  const lastErrorId = useErrorsStore((s) => s.lastErrorId);
  const lastAutoRef = useRef(0);

  // 04-§9 自动弹出：error 级问题到达时切到"问题"Tab 并展开面板
  useEffect(() => {
    if (lastErrorId > 0 && lastErrorId !== lastAutoRef.current) {
      lastAutoRef.current = lastErrorId;
      setActive('问题');
      if (collapsed) toggleBottom();
    }
  }, [lastErrorId, collapsed, toggleBottom]);

  // 切到"问题"Tab 即清未读（红点消失）
  useEffect(() => {
    if (active === '问题') markRead();
  }, [active, markRead]);

  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: e.clientY, startH: height };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setHeight(dragRef.current.startH + (dragRef.current.startY - e.clientY));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggleBottom}
        title="展开底部面板"
        className="h-2 w-full shrink-0 cursor-pointer border-t border-panel-border bg-panel transition-colors hover:bg-accent/30"
        aria-label="expand bottom panel"
      />
    );
  }

  return (
    <section
      className="flex shrink-0 flex-col border-t border-panel-border bg-panel"
      style={{ height }}
    >
      {/* 拖拽条（180–480px，04-§2） */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="group h-1.5 cursor-row-resize bg-panel-border/40 hover:bg-accent/50"
        title="拖拽调整高度"
      />

      <div className="flex h-9 items-center gap-1 border-b border-panel-border px-2">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setActive(t)}
            className={
              t === active
                ? 'rounded px-2 py-1 text-xs text-accent'
                : 'rounded px-2 py-1 text-xs text-text-secondary hover:text-text-primary'
            }
          >
            {t}
            {t === '问题' && unread > 0 && (
              <span
                data-testid="problems-badge"
                aria-label={`${unread} 条未读问题`}
                className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-danger align-top"
              />
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={toggleBottom}
          title="折叠"
          className="ml-auto px-1 text-text-secondary hover:text-text-primary"
          aria-label="collapse bottom panel"
        >
          ⌄
        </button>
      </div>

      {active === '问题' ? (
        <ProblemsTab />
      ) : active === 'diagram.json' ? (
        <DiagramTab />
      ) : active === '串口监视器' ? (
        <SerialMonitorTab />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-text-secondary">
          {active === '代码' && '代码编辑器（Monaco）待排期接入（04-§7.1）'}
          {active === '逻辑分析仪' && '逻辑分析仪随 M11 接入（04-§7.3）'}
        </div>
      )}
    </section>
  );
}
