import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCircuitStore } from '../circuit/circuitStore';
import { simSession, useSimStore } from '../stores/sim';

/**
 * 串口监视器（04-§7.3）：
 * - 数据源：simSession.subscribe('uart.rx')（引擎A stdout/UART.write、引擎B QEMU 串口同路）；
 * - 发送：input({type:'uart.tx'})，Enter 发送 \r\n，历史 ↑/↓；
 * - 缓冲（06-§3 串口终端 2MB 环形）：xterm scrollback 环形丢最旧行承载（5000 行 ≈ 2MB 上限口径）；
 * - 断连遮罩：status 为 idle/loading/building/error 时"引擎未运行"。
 */

const BAUD_OPTIONS = [9600, 19200, 38400, 57600, 115200] as const;

export default function SerialMonitorTab() {
  const status = useSimStore((s) => s.status);
  const baudrate = useCircuitStore((s) => s.doc?.serialMonitor.baudrate ?? 115200);
  const [autoscroll, setAutoscroll] = useState(true);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const autoscrollRef = useRef(autoscroll);
  autoscrollRef.current = autoscroll;
  const statusRef = useRef(status);
  statusRef.current = status;
  const lineRef = useRef('');

  // 发送历史（↑/↓，最新在末尾）
  const [sendText, setSendText] = useState('');
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);

  // xterm 初始化（一次）+ uart.rx 订阅
  useEffect(() => {
    const term = new Terminal({
      scrollback: 5000, // 环形：超限自动丢弃最旧行（06-§3 2MB 口径）
      convertEol: false,
      fontSize: 12,
      fontFamily: 'Consolas, Menlo, monospace',
      theme: {
        background: '#101418',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current as HTMLDivElement);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const ro = new ResizeObserver(() => fitRef.current?.fit());
    ro.observe(hostRef.current as HTMLDivElement);

    const unsubRx = simSession.subscribe('uart.rx', (p) => {
      term.write(p.bytes);
      if (autoscrollRef.current) term.scrollToBottom();
    });

    // 终端直接输入：行编辑 + Enter 发送 + ↑/↓ 历史（与发送框共享历史）
    term.onData((data) => {
      if (statusRef.current !== 'running' && statusRef.current !== 'paused') return;
      const engine = simSession.engine;
      if (!engine) return;
      if (data === '\r') {
        term.write('\r\n');
        engine.input({ type: 'uart.tx', bytes: new TextEncoder().encode('\r\n'), port: 0 });
        lineRef.current = '';
      } else if (data === '\x7f') {
        if (lineRef.current.length > 0) {
          lineRef.current = lineRef.current.slice(0, -1);
          term.write('\b \b');
        }
      } else if (data === '\x1b[A' || data === '\x1b[B') {
        const hist = historyRef.current;
        if (hist.length === 0) return;
        historyIdxRef.current =
          data === '\x1b[A'
            ? Math.min(historyIdxRef.current + 1, hist.length - 1)
            : Math.max(historyIdxRef.current - 1, -1);
        // 擦除当前行并回填
        for (let i = 0; i < lineRef.current.length; i++) term.write('\b \b');
        lineRef.current =
          historyIdxRef.current >= 0 ? (hist[hist.length - 1 - historyIdxRef.current] ?? '') : '';
        term.write(lineRef.current);
      } else if (data >= ' ' || data === '\t') {
        lineRef.current += data;
        term.write(data);
      }
    });

    return () => {
      unsubRx();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // status 变化不重建终端（ref 读取）
  }, []);

  const connected = status === 'running' || status === 'paused';

  const send = (): void => {
    const text = sendText;
    const engine = simSession.engine;
    if (!engine || !connected || !text) return;
    const bytes = new TextEncoder().encode(text + '\r\n');
    engine.input({ type: 'uart.tx', bytes, port: 0 });
    termRef.current?.write('\r\n↑ ' + text); // 回显（固件回读可见）
    if (historyRef.current[historyRef.current.length - 1] !== text) {
      historyRef.current.push(text);
      if (historyRef.current.length > 50) historyRef.current.shift();
    }
    historyIdxRef.current = -1;
    setSendText('');
  };

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* 工具栏（04-§7.3） */}
      <div className="flex items-center gap-2 border-b border-panel-border px-2 py-1 text-xs">
        <span
          className={`h-2 w-2 rounded-full ${connected ? 'bg-success' : 'bg-text-secondary'}`}
          title={connected ? '已连接' : '未连接'}
        />
        <select
          value={baudrate}
          disabled
          className="rounded border border-panel-border bg-panel px-1 py-0.5 text-text-secondary opacity-70"
          title="波特率（随 diagram.serialMonitor 保存；引擎侧消费随 m4-6 接入）"
        >
          {BAUD_OPTIONS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-text-secondary">
          <input
            type="checkbox"
            checked={autoscroll}
            onChange={(e) => setAutoscroll(e.target.checked)}
          />
          自动滚动
        </label>
        <button
          type="button"
          onClick={() => termRef.current?.clear()}
          className="rounded border border-panel-border px-2 py-0.5 text-text-secondary hover:text-text-primary"
        >
          清屏
        </button>
        <div className="ml-auto flex items-center gap-1">
          <input
            value={sendText}
            onChange={(e) => setSendText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                send();
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const hist = historyRef.current;
                if (hist.length === 0) return;
                historyIdxRef.current =
                  e.key === 'ArrowUp'
                    ? Math.min(historyIdxRef.current + 1, hist.length - 1)
                    : Math.max(historyIdxRef.current - 1, -1);
                setSendText(
                  historyIdxRef.current >= 0
                    ? (hist[hist.length - 1 - historyIdxRef.current] ?? '')
                    : '',
                );
              }
            }}
            disabled={!connected}
            placeholder={connected ? '发送到串口（Enter 发送）' : '引擎未运行'}
            className="w-56 rounded border border-panel-border bg-panel px-1 py-0.5 disabled:opacity-40"
          />
          <button
            type="button"
            onClick={send}
            disabled={!connected || !sendText}
            className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-40"
          >
            ▶ 发送
          </button>
        </div>
      </div>

      {/* 终端区 */}
      <div ref={hostRef} className="min-h-0 flex-1 px-1 py-0.5" />

      {/* 断连遮罩 */}
      {!connected && (
        <div className="absolute inset-0 top-8 grid place-items-center bg-panel/60 text-xs text-text-secondary backdrop-blur-[1px]">
          引擎未运行 — 点击顶栏 ▶ 运行 后开启串口
        </div>
      )}
    </div>
  );
}
