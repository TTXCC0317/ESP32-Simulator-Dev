import type { DragEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProjectMeta } from '@esp32-sim/shared';
import { api } from '../api/client';
import { useProjectStore } from '../stores/project';

/**
 * 工程列表页（04-§8）：卡片（名称/板卡/引擎/更新时间/缩略图）+ 全套操作。
 * 新建（空白/从示例）、打开、复制、导出、删除（输入工程名确认）、导入（拖拽 JSON 到页面）。
 */

const ENGINE_LABEL: Record<string, string> = {
  'micropython-wasm': 'MicroPython',
  'qemu-remote': 'Arduino(QEMU)',
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

interface Toast {
  kind: 'ok' | 'err';
  msg: string;
}

export default function ProjectListPage() {
  const navigate = useNavigate();
  const projects = useProjectStore((s) => s.projects);
  const examples = useProjectStore((s) => s.examples);
  const loading = useProjectStore((s) => s.loading);
  const storeError = useProjectStore((s) => s.error);
  const refresh = useProjectStore((s) => s.refresh);
  const clearError = useProjectStore((s) => s.clearError);
  const create = useProjectStore((s) => s.create);
  const duplicate = useProjectStore((s) => s.duplicate);
  const remove = useProjectStore((s) => s.remove);
  const importBundle = useProjectStore((s) => s.importBundle);

  const [toast, setToast] = useState<Toast | null>(null);
  const [deleting, setDeleting] = useState<ProjectMeta | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [exampleId, setExampleId] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((kind: Toast['kind'], msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ kind, msg });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onNewBlank = async () => {
    try {
      const meta = await create({ name: `工程 ${new Date().toLocaleDateString('zh-CN')}` });
      navigate(`/workbench/${meta.id}`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : String(err));
    }
  };

  const onNewFromExample = async () => {
    if (!exampleId) return;
    const ex = examples.find((e) => e.id === exampleId);
    try {
      const meta = await create({ name: ex?.name ?? exampleId, exampleId });
      navigate(`/workbench/${meta.id}`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : String(err));
    }
  };

  const onExport = async (p: ProjectMeta) => {
    try {
      const bundle = await api.exportProject(p.id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${p.name}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('ok', `已导出 ${p.name}.json`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : String(err));
    }
  };

  const readBundleFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const meta = await importBundle(JSON.parse(text));
        showToast('ok', `已导入「${meta.name}」`);
      } catch (err) {
        showToast('err', err instanceof Error ? err.message : String(err));
      }
    },
    [importBundle, showToast],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void readBundleFile(file);
  };

  const onDeleteConfirm = async () => {
    if (!deleting || confirmName !== deleting.name) return;
    await remove(deleting.id);
    showToast('ok', `已删除「${deleting.name}」`);
    setDeleting(null);
    setConfirmName('');
  };

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* 顶栏：标题 + 新建（空白 / 从示例） + 导入 */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-panel-border bg-panel px-4">
        <h1 className="text-sm font-semibold">ESP32 Simulator</h1>
        <span className="text-xs text-text-secondary">工程列表</span>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={exampleId}
            onChange={(e) => setExampleId(e.target.value)}
            aria-label="选择内置示例"
            className="rounded border border-panel-border bg-panel px-1.5 py-1.5 text-xs"
          >
            <option value="">从示例新建…</option>
            {examples.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onNewFromExample}
            disabled={!exampleId}
            className="rounded border border-panel-border px-2 py-1.5 text-xs hover:border-accent disabled:opacity-40"
          >
            创建
          </button>
          <button
            type="button"
            onClick={onNewBlank}
            className="rounded bg-accent px-3 py-1.5 text-xs text-white"
          >
            + 新建空白工程
          </button>
        </div>
      </header>

      {(storeError || toast) && (
        <div
          className={`flex items-center justify-between px-4 py-1.5 text-xs ${
            toast?.kind === 'err' || storeError ? 'bg-warn/15 text-text-primary' : 'bg-accent/15'
          }`}
        >
          <span>{toast?.msg ?? storeError}</span>
          <button type="button" onClick={() => (toast ? setToast(null) : clearError())}>
            ✕
          </button>
        </div>
      )}

      <main className="flex-1 overflow-auto p-6">
        {loading && projects.length === 0 ? (
          <p className="text-center text-sm text-text-secondary">加载中…</p>
        ) : projects.length === 0 ? (
          <div className="text-center text-text-secondary">
            <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-lg border border-panel-border bg-panel text-2xl">
              ⌁
            </div>
            <p className="text-sm">还没有工程</p>
            <p className="mt-1 text-xs">新建空白工程、从示例创建，或把工程 JSON 包拖到本页导入</p>
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {projects.map((p) => (
              <li
                key={p.id}
                className="overflow-hidden rounded-lg border border-panel-border bg-panel transition-colors hover:border-accent"
              >
                <button
                  type="button"
                  onClick={() => navigate(`/workbench/${p.id}`)}
                  title={`打开 ${p.name}`}
                  className="block h-36 w-full bg-bg"
                >
                  {p.thumbnail ? (
                    <img src={p.thumbnail} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="grid h-full w-full place-items-center text-3xl text-text-secondary">
                      ⌁
                    </span>
                  )}
                </button>
                <div className="p-3">
                  <p className="truncate text-sm font-medium" title={p.name}>
                    {p.name}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5 text-[10px] text-text-secondary">
                    <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">
                      {p.boardType}
                    </span>
                    <span className="rounded border border-panel-border px-1.5 py-0.5">
                      {ENGINE_LABEL[p.engine] ?? p.engine}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] text-text-secondary">{fmtTime(p.updatedAt)}</p>
                  <div className="mt-2 flex items-center gap-1 text-xs">
                    <button
                      type="button"
                      onClick={() => navigate(`/workbench/${p.id}`)}
                      className="rounded bg-accent px-2 py-1 text-white"
                    >
                      打开
                    </button>
                    <button
                      type="button"
                      onClick={() => void duplicate(p.id)}
                      title="复制工程"
                      className="rounded border border-panel-border px-2 py-1 hover:border-accent"
                    >
                      复制
                    </button>
                    <button
                      type="button"
                      onClick={() => void onExport(p)}
                      title="导出 JSON 包"
                      className="rounded border border-panel-border px-2 py-1 hover:border-accent"
                    >
                      导出
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDeleting(p);
                        setConfirmName('');
                      }}
                      title="删除工程"
                      className="ml-auto rounded border border-panel-border px-2 py-1 hover:border-warn hover:text-warn"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      {/* 删除二次确认：输入工程名（04-§8） */}
      {deleting && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-80 rounded-lg border border-panel-border bg-panel p-4">
            <h2 className="text-sm font-semibold">删除工程「{deleting.name}」</h2>
            <p className="mt-1 text-xs text-text-secondary">该操作不可恢复（含全部源码文件）。</p>
            <input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={`输入工程名 "${deleting.name}" 确认`}
              aria-label="确认删除：输入工程名"
              className="mt-3 w-full rounded border border-panel-border bg-bg px-2 py-1.5 text-xs focus:border-warn focus:outline-none"
            />
            <div className="mt-3 flex justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={() => setDeleting(null)}
                className="rounded border border-panel-border px-3 py-1.5"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void onDeleteConfirm()}
                disabled={confirmName !== deleting.name}
                className="rounded bg-warn px-3 py-1.5 text-white disabled:opacity-40"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 拖拽导入提示层 */}
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-accent/10">
          <p className="rounded-lg border-2 border-dashed border-accent bg-panel px-6 py-4 text-sm text-accent">
            松开以导入工程 JSON 包
          </p>
        </div>
      )}
    </div>
  );
}
