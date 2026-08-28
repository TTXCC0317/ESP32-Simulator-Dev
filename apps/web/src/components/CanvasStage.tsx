import { Link } from 'react-router-dom';

/** 画布占位（04-§2/§12）：Konva Stage 随 M2 接入；网格用 --grid token */
export default function CanvasStage() {
  return (
    <div
      className="relative min-w-0 flex-1 bg-bg"
      style={{
        backgroundImage:
          'linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px)',
        backgroundSize: '20px 20px',
      }}
    >
      {/* 空态引导卡（04-§12） */}
      <div className="absolute inset-0 grid place-items-center">
        <div className="rounded-lg border border-panel-border bg-panel p-6 text-center shadow-sm">
          <p className="text-sm text-text-primary">从左侧元件库拖入元件开始搭建</p>
          <p className="mt-1 text-xs text-text-secondary">拖拽与连线随 M2 接入</p>
          <Link to="/" className="mt-3 inline-block text-xs text-accent underline">
            返回工程列表
          </Link>
        </div>
      </div>
    </div>
  );
}
