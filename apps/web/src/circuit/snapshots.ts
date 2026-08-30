import type { CircuitDoc } from '@esp32-sim/shared';

/**
 * 画布自动快照（06-§7.2 F2，M6）：
 * - 触发：工程保存（PUT）成功后写入最近一次成功保存的 CircuitDoc；
 * - 存储：IndexedDB `esp32-sim` 库 `snapshots` store，单键 `project:<id>` 持数组（环形 5 槽），
 *   不存后端（避免污染 SQLite 权威数据；快照仅为修复辅助）；
 * - 回退：diagram.json 损坏时，修复入口列出最近 5 条（时间戳 + 元件数）供恢复；
 * - TTL：读取时过滤 >24h 的记录（惰性清理，避免 IndexedDB 累积）。
 */

const DB_NAME = 'esp32-sim';
const DB_VERSION = 1;
const STORE = 'snapshots';
const MAX_SLOTS = 5;
const TTL_MS = 24 * 3_600_000;

export interface CanvasSnapshot {
  ts: number;
  /** 快照内元件数（列表展示用） */
  parts: number;
  doc: CircuitDoc;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'));
    });
  } finally {
    db.close();
  }
}

/** 保存成功后追加快照（环形 5 槽，最旧先出）；IndexedDB 失败静默（快照为尽力而为） */
export async function pushSnapshot(projectId: string, doc: CircuitDoc): Promise<void> {
  try {
    const key = `project:${projectId}`;
    const prev = await withStore<CanvasSnapshot[] | undefined>(
      'readonly',
      (s) => s.get(key) as IDBRequest<CanvasSnapshot[] | undefined>,
    );
    const items = [...(prev ?? []), { ts: Date.now(), parts: doc.parts.length, doc }];
    if (items.length > MAX_SLOTS) items.splice(0, items.length - MAX_SLOTS);
    await withStore('readwrite', (s) => s.put(items, key) as unknown as IDBRequest<undefined>);
  } catch {
    // 快照失败不影响保存主流程
  }
}

/** 列出可恢复快照（新→旧；过滤 TTL 外记录） */
export async function listSnapshots(projectId: string): Promise<CanvasSnapshot[]> {
  try {
    const items =
      (await withStore<CanvasSnapshot[] | undefined>(
        'readonly',
        (s) => s.get(`project:${projectId}`) as IDBRequest<CanvasSnapshot[] | undefined>,
      )) ?? [];
    const cutoff = Date.now() - TTL_MS;
    return items.filter((it) => it.ts >= cutoff).reverse();
  } catch {
    return [];
  }
}
