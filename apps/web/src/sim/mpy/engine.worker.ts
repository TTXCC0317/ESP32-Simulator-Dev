/// <reference lib="webworker" />
import type { EngineEvent, WorkerMsg, WorkerReply } from '@esp32-sim/shared';
import { workerMsgSchema } from '@esp32-sim/shared';
import { MpyWasmEngine } from './engine';

/**
 * EngineWorker（03-§3.5 / N22）：主线程 ⇄ Worker 纯 postMessage，不依赖 SharedArrayBuffer。
 * 高频事件 16ms 窗口聚合为 event.batch；state/log/ready 立即发送。
 * 入口消息经 workerMsgSchema 校验（失败 postMessage log.error 并跳过）。
 */

const engine = new MpyWasmEngine();
const batch: EngineEvent[] = [];
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // setTimeout（Worker 内无 rAF）；16ms 窗口聚合高频 gpio.write/uart.rx
  setTimeout(() => {
    flushScheduled = false;
    if (batch.length) {
      const reply: WorkerReply = { type: 'event.batch', payload: { events: batch.splice(0) } };
      postMessage(reply);
    }
  }, 16);
}

// 引擎事件 → batch（state/log 立即送，见 §3.5）
for (const type of [
  'gpio.write',
  'pwm.duty',
  'uart.rx',
  'i2c.txn',
  'spi.txn',
  'fb.update',
] as const) {
  engine.on(type, (payload) => {
    batch.push({ kind: type, ...payload } as EngineEvent);
    scheduleFlush();
  });
}
engine.on('log', (payload) => {
  postMessage({ type: 'log', payload } satisfies WorkerReply);
});
engine.on('state', (payload) => {
  postMessage({ type: 'state', payload } satisfies WorkerReply);
});

self.onmessage = async (e: MessageEvent<WorkerMsg>) => {
  const parsed = workerMsgSchema.safeParse(e.data);
  if (!parsed.success) {
    postMessage({
      type: 'log',
      payload: { level: 'error', text: `Worker 消息校验失败：${parsed.error.message}` },
    } satisfies WorkerReply);
    return;
  }
  const msg = parsed.data as WorkerMsg;
  try {
    switch (msg.type) {
      case 'load':
        await engine.load(msg.payload.circuit, msg.payload.fw);
        postMessage({
          type: 'ready',
          payload: { wasmMemBytes: engine.memBytes() },
        } satisfies WorkerReply);
        break;
      case 'start':
        engine.start(msg.payload.speed !== undefined ? { speed: msg.payload.speed } : undefined);
        break;
      case 'pause':
        engine.pause();
        break;
      case 'reset':
        await engine.reset();
        break;
      case 'input':
        engine.input(msg.payload);
        break;
      case 'dispose':
        engine.dispose();
        self.close();
        break;
    }
  } catch (err) {
    postMessage({
      type: 'log',
      payload: {
        level: 'error',
        text: `Worker 处理 ${msg.type} 失败：${err instanceof Error ? err.message : String(err)}`,
      },
    } satisfies WorkerReply);
  }
};
