import { Link } from 'react-router-dom';

/** 工程列表页骨架（04-§8；数据接入随 M3） */
export default function ProjectListPage() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center justify-between border-b border-panel-border bg-panel px-4">
        <h1 className="text-sm font-semibold">ESP32 Simulator</h1>
        <button
          type="button"
          disabled
          title="工程管理随 M3 接入"
          className="rounded bg-accent px-3 py-1.5 text-xs text-white opacity-50"
        >
          新建工程
        </button>
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="text-center text-text-secondary">
          <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-lg border border-panel-border bg-panel text-2xl">
            ⌁
          </div>
          <p className="text-sm">还没有工程</p>
          <p className="mt-1 text-xs">
            工程管理与示例载入随 M3 接入，届时可新建第一个工程或导入 JSON
          </p>
          <Link to="/workbench/demo" className="mt-4 inline-block text-xs text-accent underline">
            先看看工作台骨架 →
          </Link>
        </div>
      </main>
    </div>
  );
}
