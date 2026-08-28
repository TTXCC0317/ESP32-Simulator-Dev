import { useParams, Link } from 'react-router-dom';
import TopBar from '../components/TopBar';
import LibraryPanel from '../components/LibraryPanel';
import CircuitCanvas from '../canvas/CircuitCanvas';
import InspectorPanel from '../components/InspectorPanel';
import BottomPanel from '../components/BottomPanel';

/**
 * 工作台四区布局骨架（04-§2）：
 * TopBar 48px / Library 280px | Canvas flex-1 | Inspector 自适应 / BottomPanel 260px(180–480)
 * <1280px Inspector 悬浮抽屉；<960px 顶部提示建议桌面浏览器。
 */
export default function WorkbenchPage() {
  const { projectId } = useParams();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-center bg-warn/15 px-4 py-1 text-center text-xs text-text-primary max-[959px]:flex">
        <span>当前窗口较窄，建议使用桌面浏览器获得完整工作台体验</span>
      </div>
      <TopBar projectName={projectId ?? ''} />
      <div className="relative flex min-h-0 flex-1">
        <LibraryPanel />
        <CircuitCanvas />
        <InspectorPanel />
      </div>
      <BottomPanel />
    </div>
  );
}

export function BackToList() {
  return <Link to="/">返回工程列表</Link>;
}
