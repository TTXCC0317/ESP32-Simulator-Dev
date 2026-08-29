import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircuitDoc } from '@esp32-sim/shared';
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
});
