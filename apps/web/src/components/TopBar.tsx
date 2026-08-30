import { useEffect, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { useCircuitStore } from '../circuit/circuitStore';
import { pauseSession, resetSession, runSession, stopSession } from '../sim/run-session';
import { api, type ToolsStatus } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useSimStore, type SimStatus, type SimSpeed } from '../stores/sim';
import { useUiStore } from '../stores/ui';

/**
 * TopBar（04-§3）：Logo/工程名（行内编辑）/引擎组/运行组/保存状态/主题切换。
 * M4：引擎A（MicroPython-WASM）+ 引擎B（QEMU）双引擎；B 依据 /api/health/tools
 * 探测 arduino-cli/esptool/QEMU，缺失则置灰（04-§3 引擎组约束）；速度选择 QEMU 禁用（仅 1×）。
 */

const STATUS_DOT: Record<SimStatus, { cls: string; label: string }> = {
  idle: { cls: 'bg-text-secondary', label: '空闲' },
  loading: { cls: 'bg-warn animate-pulse', label: '装载中' },
  building: { cls: 'bg-warn animate-pulse', label: '编译中' },
  running: { cls: 'bg-success animate-pulse', label: '运行中' },
  paused: { cls: 'bg-accent', label: '已暂停' },
  error: { cls: 'bg-danger', label: '错误' },
};

const SPEED_OPTIONS: Array<{ value: SimSpeed; label: string }> = [
  { value: 0.25, label: '0.25×' },
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
];

export default function TopBar() {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const muted = useUiStore((s) => s.muted);
  const toggleMuted = useUiStore((s) => s.toggleMuted);
  const dirty = useCircuitStore((s) => s.dirty);
  const current = useProjectStore((s) => s.current);
  const saving = useProjectStore((s) => s.saving);
  const savedAt = useProjectStore((s) => s.savedAt);
  const renameCurrent = useProjectStore((s) => s.renameCurrent);
  const saveCurrent = useProjectStore((s) => s.saveCurrent);
  const leaveCurrent = useProjectStore((s) => s.leaveCurrent);

  const status = useSimStore((s) => s.status);
  const engineKind = useSimStore((s) => s.engineKind);
  const setEngineKind = useSimStore((s) => s.setEngineKind);
  const speed = useSimStore((s) => s.speed);
  const setSpeed = useSimStore((s) => s.setSpeed);
  const lastError = useSimStore((s) => s.lastError);
  const build = useSimStore((s) => s.build);

  // 工具链探测（挂载一次）：arduino-cli + esptool + QEMU 全部就绪才启用引擎B
  const [tools, setTools] = useState<ToolsStatus | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .getTools()
      .then((t) => {
        if (alive) setTools(t);
      })
      .catch(() => {
        /* 探测失败按未配置处理（按钮保持置灰） */
      });
    return () => {
      alive = false;
    };
  }, []);

  const missingTools: string[] = [];
  if (tools) {
    if (!tools.arduinoCli.ok) missingTools.push('arduino-cli');
    if (!tools.esptool.ok) missingTools.push('esptool');
    if (!tools.qemu.ok) missingTools.push('QEMU');
  }
  const qemuReady = tools !== null && missingTools.length === 0;

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
    stopSession(); // 离开工作台即停止会话
    leaveCurrent();
  };

  const canRun = status === 'idle' || status === 'paused' || status === 'error';
  const canPause = status === 'running';
  const canReset = status === 'paused' || status === 'error';
  const canStop =
    status === 'loading' || status === 'building' || status === 'running' || status === 'paused';
  // 引擎切换仅空闲/错误态允许（运行中切换需先停止会话）
  const canSwitch = status === 'idle' || status === 'error';

  const dot = STATUS_DOT[status];
  const dotTitle =
    status === 'building' && build
      ? `状态：编译中（${build.phase}，${Math.round(build.progress * 100)}%）`
      : `状态：${dot.label}`;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-panel-border bg-panel px-3">
      {/* Logo：点击回工程列表（脏数据确认 + 停止会话） */}
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

      {/* 引擎选择 Segmented（04-§3）：A=浏览器 WASM；B=QEMU（工具链缺失置灰，tooltip 列缺失项） */}
      <div className="flex overflow-hidden rounded border border-panel-border text-xs">
        <button
          type="button"
          onClick={() => setEngineKind('micropython-wasm')}
          disabled={!canSwitch}
          className={
            engineKind === 'micropython-wasm'
              ? 'bg-accent/20 px-2 py-1 text-accent'
              : 'px-2 py-1 text-text-secondary hover:text-text-primary disabled:hover:text-text-secondary'
          }
        >
          MicroPython
        </button>
        <button
          type="button"
          onClick={() => setEngineKind('qemu-remote')}
          disabled={!canSwitch || !qemuReady}
          title={
            !qemuReady
              ? tools === null
                ? '正在探测工具链（arduino-cli / esptool / QEMU）…'
                : `工具链缺失：${missingTools.join('、')}（见 app.example.json §7.6 配置说明）`
              : engineKind === 'qemu-remote'
                ? '引擎B（当前）'
                : '引擎B：服务端 QEMU 运行 Arduino 固件'
          }
          className={
            engineKind === 'qemu-remote'
              ? 'bg-accent/20 px-2 py-1 text-accent'
              : 'px-2 py-1 text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-text-secondary'
          }
        >
          Arduino(QEMU)
        </button>
      </div>

      {/* 运行组（04-§3）：▶ 运行 / ⏸ 暂停（KeyboardInterrupt）/ ⟳ 重置 / ⏹ 停止 */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={!canRun}
          onClick={() => void runSession()}
          title={canRun ? '运行仿真' : lastError ? `错误：${lastError.detail}` : '当前状态不可运行'}
          className="rounded bg-accent px-2 py-1 text-xs text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          ▶ 运行
        </button>
        <button
          type="button"
          disabled={!canPause}
          onClick={pauseSession}
          title={canPause ? '暂停（注入 KeyboardInterrupt）' : '仅运行中可暂停'}
          className="rounded border border-panel-border px-2 py-1 text-xs text-text-secondary disabled:cursor-not-allowed disabled:opacity-40"
        >
          ⏸
        </button>
        <button
          type="button"
          disabled={!canReset}
          onClick={resetSession}
          title={canReset ? '重置仿真（重建解释器）' : '仅暂停/错误状态可重置'}
          className="rounded border border-panel-border px-2 py-1 text-xs text-text-secondary disabled:cursor-not-allowed disabled:opacity-40"
        >
          ⟳
        </button>
        <button
          type="button"
          disabled={!canStop}
          onClick={stopSession}
          title={canStop ? '停止会话' : '无进行中的会话'}
          className="rounded border border-panel-border px-2 py-1 text-xs text-text-secondary disabled:cursor-not-allowed disabled:opacity-40"
        >
          ⏹
        </button>
      </div>

      {/* 状态灯：idle 灰 / loading·building 黄(脉冲) / running 绿 / paused 蓝(accent) / error 红 */}
      <span
        title={dotTitle}
        className={`h-2.5 w-2.5 rounded-full ${dot.cls}`}
        aria-label={`engine status: ${status}`}
      />

      {/* 速度：引擎A 倍速生效随 M5；QEMU 固定 1×（03-§3.3） */}
      <select
        value={speed}
        onChange={(e) => setSpeed(Number(e.target.value) as SimSpeed)}
        disabled={engineKind === 'qemu-remote'}
        title={
          engineKind === 'qemu-remote'
            ? '引擎B（QEMU）仅支持 1× 速度'
            : '速度（引擎A 倍速生效随 M5）'
        }
        className="rounded border border-panel-border bg-panel px-1 py-1 text-xs text-text-secondary disabled:opacity-50"
      >
        {SPEED_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
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

        {/* 静音切换（05-§1.8 E4）：与主题切换并列，持久化到 uiStore.muted */}
        <button
          type="button"
          onClick={toggleMuted}
          title={muted ? '取消静音（蜂鸣器）' : '静音（蜂鸣器）'}
          aria-label="toggle mute"
          className="grid h-7 w-7 place-items-center rounded border border-panel-border text-text-secondary hover:text-text-primary"
        >
          {muted ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              <path d="m23 9-6 6M17 9l6 6" />
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
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
            </svg>
          )}
        </button>

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
