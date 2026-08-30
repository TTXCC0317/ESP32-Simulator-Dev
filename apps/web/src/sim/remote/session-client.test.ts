import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircuitDoc } from '@esp32-sim/shared';
import { useErrorsStore } from '../../stores/errors';
import { useProjectStore } from '../../stores/project';
import { useSimStore } from '../../stores/sim';
import { RemoteSessionClient } from './session-client';

/**
 * L2（02-§4 M4 测试项）：引擎B 前端客户端——N2 状态映射 / build.progress 消费 /
 * uart 双向转换 / build 提交 attach 流程。WebSocket 与 fetch 用 stub（jsdom 环境）。
 */

const circuit: CircuitDoc = {
  formatVersion: 1,
  boardType: 'esp32-devkit-c-v4',
  parts: [],
  connections: [],
  serialMonitor: { baudrate: 115200 },
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  /** 测试侧模拟服务端下发 */
  serverSend(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function lastWs(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error('未创建 WS 连接');
  return ws;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url).includes('/api/build')) {
        return { ok: true, status: 202, json: async () => ({ buildId: 'bld-t1' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  useSimStore.setState({
    engineKind: 'qemu-remote',
    status: 'idle',
    build: null,
    lastError: undefined,
  });
  useErrorsStore.setState({ items: [], unread: 0, lastErrorId: 0 });
  useProjectStore.setState({
    current: { id: 'p-1', name: 't' } as ReturnType<typeof useProjectStore.getState>['current'],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RemoteSessionClient（03-§6.3/§7.3 引擎B 前端）', () => {
  it('load：提交 build → attach → state running 时 resolve（N2 映射 building-wait→building）', async () => {
    const c = new RemoteSessionClient();
    const loadP = c.load(circuit, { kind: 'sources', files: [] });

    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = lastWs();
    ws.onopen?.();

    // attach 消息：projectId/firmwareId/boardType 正确
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    const attach = JSON.parse(ws.sent[0] ?? '') as {
      type: string;
      payload: { projectId: string; firmwareId: string; boardType: string };
    };
    expect(attach.type).toBe('attach');
    expect(attach.payload).toMatchObject({
      projectId: 'p-1',
      firmwareId: 'bld-t1',
      boardType: 'esp32-devkit-c-v4',
    });

    // attaching → loading
    ws.serverSend({ type: 'state', payload: { status: 'attaching' } });
    expect(useSimStore.getState().status).toBe('loading');

    // building-wait → building
    ws.serverSend({ type: 'state', payload: { status: 'building-wait' } });
    expect(useSimStore.getState().status).toBe('building');

    // 编译进度推送 → simStore.build
    ws.serverSend({
      type: 'build.progress',
      payload: {
        buildId: 'bld-t1',
        phase: 'compiling',
        progress: 0.42,
        logLines: ['Compiling x.c'],
      },
    });
    expect(useSimStore.getState().build).toEqual({ phase: 'compiling', progress: 0.42 });

    // running → load resolve + status running（build 清空）
    ws.serverSend({ type: 'state', payload: { status: 'running' } });
    await loadP;
    expect(useSimStore.getState().status).toBe('running');
    expect(useSimStore.getState().build).toBeNull();

    c.dispose();
  });

  it('build.progress failed → load reject（编译失败冒泡 runSession error 路径）', async () => {
    const c = new RemoteSessionClient();
    const loadP = c.load(circuit, { kind: 'sources', files: [] });
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = lastWs();
    ws.onopen?.();
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));

    ws.serverSend({
      type: 'build.progress',
      payload: { buildId: 'bld-t1', phase: 'failed', progress: 1, error: 'sketch error' },
    });
    await expect(loadP).rejects.toThrow('sketch error');
  });

  it('uart.rx → bytes 转 Uint8Array；input(uart.tx) → WS input.uart', async () => {
    const c = new RemoteSessionClient();
    const loadP = c.load(circuit, { kind: 'sources', files: [] });
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = lastWs();
    ws.onopen?.();
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    ws.serverSend({ type: 'state', payload: { status: 'running' } });
    await loadP;

    const rx = await new Promise<Uint8Array>((res) => {
      const unsub = c.on('uart.rx', (p) => {
        unsub();
        res(p.bytes);
      });
      ws.serverSend({ type: 'uart.rx', payload: { bytes: [104, 105] } });
    });
    expect(new TextDecoder().decode(rx)).toBe('hi');

    c.input({ type: 'uart.tx', bytes: new Uint8Array([111, 107]) });
    const out = JSON.parse(ws.sent.at(-1) ?? '') as {
      type: string;
      payload: { bytes: number[] };
    };
    expect(out).toEqual({ type: 'input.uart', payload: { bytes: [111, 107] } });

    c.dispose();
  });

  it('state closed → simStore idle；dispose 后断线不上报错误', async () => {
    const c = new RemoteSessionClient();
    const loadP = c.load(circuit, { kind: 'sources', files: [] });
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = lastWs();
    ws.onopen?.();
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    ws.serverSend({ type: 'state', payload: { status: 'running' } });
    await loadP;

    // ctrl stop → 服务端 close 前下发 closed
    ws.serverSend({ type: 'state', payload: { status: 'closed' } });
    expect(useSimStore.getState().status).toBe('idle');

    c.dispose();
    expect(useSimStore.getState().status).toBe('idle');
  });

  it('错误面板聚合（04-§9）：编译诊断定位 / 编译失败 / state error / error.ack / 断线', async () => {
    const c = new RemoteSessionClient();
    const loadP = c.load(circuit, { kind: 'sources', files: [] });
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = lastWs();
    ws.onopen?.();
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));

    // 编译 critical 行：诊断行入面板（带定位），非诊断行不入
    ws.serverSend({
      type: 'build.progress',
      payload: {
        buildId: 'bld-t1',
        phase: 'compiling',
        progress: 0.5,
        logLines: [
          'src/main/sketch/main.ino.cpp:12:5: error: xyz was not declared',
          'Compiling core a.c',
        ],
      },
    });
    const buildItems = useErrorsStore.getState().items.filter((i) => i.source === 'build');
    expect(buildItems).toHaveLength(1);
    expect(buildItems[0]).toMatchObject({
      severity: 'error',
      title: 'xyz was not declared',
      file: 'src/main/sketch/main.ino.cpp',
      line: 12,
      col: 5,
    });
    expect(useErrorsStore.getState().unread).toBe(1);

    // 编译失败 → build 汇总条目 + lastErrorId（红点/自动弹出驱动）
    ws.serverSend({
      type: 'build.progress',
      payload: { buildId: 'bld-t1', phase: 'failed', progress: 1, error: 'exit 1' },
    });
    await expect(loadP).rejects.toThrow('exit 1');
    expect(useErrorsStore.getState().items.at(-1)).toMatchObject({
      source: 'build',
      title: '编译失败',
      detail: 'exit 1',
    });
    expect(useErrorsStore.getState().lastErrorId).toBeGreaterThan(0);

    // state error → engine 条目
    ws.serverSend({ type: 'state', payload: { status: 'error', error: 'QEMU spawn fail' } });
    expect(useErrorsStore.getState().items.at(-1)).toMatchObject({
      source: 'engine',
      title: '引擎B 运行错误',
      detail: 'QEMU spawn fail',
    });

    // error.ack → session 条目
    ws.serverSend({ type: 'error.ack', payload: { code: 'WS_MSG_INVALID', message: 'bad msg' } });
    expect(useErrorsStore.getState().items.at(-1)).toMatchObject({
      source: 'session',
      title: '[WS_MSG_INVALID] bad msg',
    });

    // 进入 running（F1 仅对 running 后断线做退避重连；load 阶段断线直接报错）
    ws.serverSend({ type: 'state', payload: { status: 'running' } });

    // 非主动关闭（断线）→ F1 重连：不立即报错，进入 loading 并排程重连
    ws.onclose?.();
    expect(useSimStore.getState().status).toBe('loading');
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    const ws2 = lastWs();
    ws2.onopen?.();
    await vi.waitFor(() => expect(ws2.sent.length).toBeGreaterThan(0));
    // 重连后 running → 状态恢复 + 退避复位
    ws2.serverSend({ type: 'state', payload: { status: 'running' } });
    expect(useSimStore.getState().status).toBe('running');

    c.dispose();
  });

  it('断线重连 5 次失败 → 停止重连并报会话错误（F1 退避 1/2/4/8/16s）', async () => {
    vi.useFakeTimers();
    try {
      const c = new RemoteSessionClient();
      const loadP = c.load(circuit, { kind: 'sources', files: [] });
      await vi.advanceTimersByTimeAsync(0);
      const ws = lastWs();
      ws.onopen?.();
      ws.serverSend({ type: 'state', payload: { status: 'running' } });
      await loadP;
      expect(FakeWebSocket.instances).toHaveLength(1);

      // 5 轮断线 → 排程重连 → 新 socket 未 open 即断
      for (const delay of [1000, 2000, 4000, 8000, 16000]) {
        lastWs().onclose?.();
        await vi.advanceTimersByTimeAsync(delay);
      }
      expect(FakeWebSocket.instances).toHaveLength(6);

      // 第 6 次断线：退避耗尽 → 会话错误入面板
      lastWs().onclose?.();
      expect(useSimStore.getState().status).toBe('error');
      expect(useErrorsStore.getState().items.at(-1)).toMatchObject({
        source: 'session',
        title: '引擎B 会话错误',
        detail: '会话已断开（重连 5 次失败），请点击重试或重新运行',
      });
      c.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
