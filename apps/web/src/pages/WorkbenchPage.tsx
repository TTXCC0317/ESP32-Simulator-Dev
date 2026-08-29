import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import TopBar from '../components/TopBar';
import LibraryPanel from '../components/LibraryPanel';
import CircuitCanvas from '../canvas/CircuitCanvas';
import InspectorPanel from '../components/InspectorPanel';
import BottomPanel from '../components/BottomPanel';
import { useCircuitStore } from '../circuit/circuitStore';
import { useProjectStore } from '../stores/project';

/**
 * 工作台四区布局（04-§2）：
 * TopBar 48px / Library 280px | Canvas flex-1 | Inspector 自适应 / BottomPanel 260px(180–480)
 * <1280px Inspector 悬浮抽屉；<960px 顶部提示建议桌面浏览器。
 *
 * M3：挂载时加载工程（diagram → circuitStore），Ctrl+S 保存，脏数据离开确认。
 */
export default function WorkbenchPage() {
  const { projectId } = useParams();
  const [ready, setReady] = useState(false);
  const current = useProjectStore((s) => s.current);
  const error = useProjectStore((s) => s.error);

  // 加载工程；卸载/切换时清理 current（diagram 保留在 circuitStore，避免闪烁）
  useEffect(() => {
    let alive = true;
    setReady(false);
    if (projectId) {
      void useProjectStore
        .getState()
        .loadCurrent(projectId)
        .then((ok) => {
          if (alive) setReady(true);
          void ok;
        });
    } else {
      setReady(true);
    }
    return () => {
      alive = false;
      useProjectStore.getState().leaveCurrent();
    };
  }, [projectId]);

  // Ctrl+S 保存（04-§10）；关页面前脏数据提醒
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void useProjectStore.getState().saveCurrent();
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useCircuitStore.getState().dirty) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-secondary">
        加载工程中…
      </div>
    );
  }

  if (!current) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-secondary">
        <p className="text-sm">{error ?? '工程不存在或已被删除'}</p>
        <Link to="/" className="text-xs text-accent underline">
          ← 返回工程列表
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-center bg-warn/15 px-4 py-1 text-center text-xs text-text-primary max-[959px]:flex">
        <span>当前窗口较窄，建议使用桌面浏览器获得完整工作台体验</span>
      </div>
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <LibraryPanel />
        <CircuitCanvas />
        <InspectorPanel />
      </div>
      <BottomPanel />
    </div>
  );
}
