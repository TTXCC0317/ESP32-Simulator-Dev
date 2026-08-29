import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { useCircuitStore } from '../circuit/circuitStore';
import { useProjectStore } from '../stores/project';
import { useUiStore } from '../stores/ui';

/**
 * TopBar（04-§3）：Logo/工程名（行内编辑）/引擎组/保存状态/主题切换。
 * 运行组与引擎选择随 M4 接入；保存流程（PUT + 缩略图）M3 已接。
 */
export default function TopBar() {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const dirty = useCircuitStore((s) => s.dirty);
  const current = useProjectStore((s) => s.current);
  const saving = useProjectStore((s) => s.saving);
  const savedAt = useProjectStore((s) => s.savedAt);
  const renameCurrent = useProjectStore((s) => s.renameCurrent);
  const saveCurrent = useProjectStore((s) => s.saveCurrent);
  const leaveCurrent = useProjectStore((s) => s.leaveCurrent);

  const savedLabel = dirty
    ? '有未保存修改'
    : savedAt
      ? `已保存 ${new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
      : '已保存';

  const onLogoClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (dirty && !window.confirm('有未保存修改，离开将丢失，确定返回工程列表？')) {
      e.preventDefault();
      return;
    }
    leaveCurrent();
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-panel-border bg-panel px-3">
      {/* Logo：点击回工程列表（脏数据确认） */}
      <Link
        to="/"
        onClick={onLogoClick}
        title="返回工程列表"
        className="grid h-8 w-8 place-items-center rounded bg-accent text-sm font-bold text-white"
      >
        E
      </Link>

      {/* 工程名：行内编辑（PUT projects.name，随保存提交） */}
      <input
        value={current?.name ?? ''}
        onChange={(e) => renameCurrent(e.target.value)}
        placeholder="未命名工程"
        aria-label="工程名"
        className="w-40 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium hover:border-panel-border focus:border-accent focus:outline-none"
      />

      <div className="mx-1 h-6 w-px bg-panel-border" />

      {/* 引擎选择 Segmented：M4 接引擎A/B；工具链缺失时 B 项禁用+tooltip */}
      <div className="flex overflow-hidden rounded border border-panel-border text-xs">
        <button type="button" className="bg-accent/20 px-2 py-1 text-accent">
          MicroPython
        </button>
        <button
          type="button"
          disabled
          title="引擎B（QEMU）随 M4 接入"
          className="px-2 py-1 text-text-secondary opacity-50"
        >
          Arduino(QEMU)
        </button>
      </div>

      {/* 运行组：M4 接引擎后启用 */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled
          title="运行随 M4 接入"
          className="rounded bg-accent px-2 py-1 text-xs text-white opacity-40"
        >
          ▶ 运行
        </button>
        {(['⏸', '⟳', '⏹'] as const).map((s) => (
          <button
            key={s}
            type="button"
            disabled
            title="随 M4 接入"
            className="rounded border border-panel-border px-2 py-1 text-xs text-text-secondary opacity-40"
          >
            {s}
          </button>
        ))}
      </div>

      {/* 状态灯：idle 灰（building 黄/running 绿/paused 蓝/error 红 随 M4） */}
      <span
        title="状态：idle"
        className="h-2.5 w-2.5 rounded-full bg-text-secondary"
        aria-label="engine status: idle"
      />

      {/* 速度：QEMU 仅 1×；M4 接入 */}
      <select
        disabled
        title="速度调节随 M4 接入"
        className="rounded border border-panel-border bg-panel px-1 py-1 text-xs text-text-secondary opacity-50"
      >
        <option>1×</option>
      </select>

      <div className="ml-auto flex items-center gap-3">
        {/* 保存：Ctrl+S / 按钮（PUT diagram + files 缩略图） */}
        <button
          type="button"
          onClick={() => void saveCurrent()}
          disabled={!current || !dirty || saving}
          title="保存工程（Ctrl+S）"
          className="rounded bg-accent px-2.5 py-1 text-xs text-white disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <span className={`text-xs ${dirty ? 'text-warn' : 'text-text-secondary'}`}>
          {savedLabel}
        </span>

        {/* 主题切换：即时切换并持久化（04-§3） */}
        <button
          type="button"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
          aria-label="toggle theme"
          className="grid h-7 w-7 place-items-center rounded border border-panel-border text-text-secondary hover:text-text-primary"
        >
          {theme === 'dark' ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}
