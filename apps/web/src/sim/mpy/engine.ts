import type {
  CircuitDoc,
  EngineEventMap,
  EngineEventType,
  EngineStatus,
  FirmwareInput,
  InputEvent,
  PartDefinition,
  PinRef,
  SimulationEngine,
} from '@esp32-sim/shared';
import { boardDefinitionSchema } from '@esp32-sim/shared';
import { P1_CATALOG } from '../../circuit/catalog-data';
import boardRaw from '../../../../../config/boards/esp32-devkit-c-v4.json';
import { PinBus, type Level, type Pull } from '../pinbus';
import { loadMicroPython, writeVfs, type LoadedMpy } from './loader';

/**
 * MpyWasmEngine（03-§3，引擎A，运行于 EngineWorker 内）。
 *
 * - machine shim 的 JS 桥（globalThis.__mpyMachine，见 tools/mpy-build/machine-shim/machine.c）：
 *   gpioWrite/gpioRead/uartWrite/uartRead/uartAvailable → PinBus / 事件流；
 * - stdout（print）→ uart.rx port 0（REPL 与 UART0 同路，串口监视器展示）；
 * - load() 写 VFS（FS 缺失时降级 do_str 单文件）；start() 执行 main.py；
 * - pause() 注入 KeyboardInterrupt（导出缺失时仅告警，死循环需停止会话）；
 * - speed 倍率引擎A M4 不生效（wasm 内 sleep 无法缩放，M5 处理，见 03-§3.3）。
 */

const BOARD_DEF = boardDefinitionSchema.parse(boardRaw);

/** machine.c 的 pull 常量（machine_pin_locals_dict_table）→ PinBus Pull */
const PULL_BY_CONST: Record<number, Pull> = { 0: 'none', 1: 'down', 2: 'up' };

type Handler<K extends EngineEventType> = (payload: EngineEventMap[K]) => void;

export class MpyWasmEngine implements SimulationEngine {
  readonly kind = 'micropython-wasm' as const;

  private bus = new PinBus();
  private wasm: LoadedMpy | null = null;
  private state: EngineStatus = 'idle';
  private handlers = new Map<EngineEventType, Set<Handler<EngineEventType>>>();
  private seq = { gpio: 0, i2c: 0, spi: 0 };

  /** GPIO 数字 → PinRef（板卡实例 id + 引脚名），machine shim 数字引脚映射 */
  private gpioRefs = new Map<number, PinRef>();
  private outputTokens = new Map<number, number>();
  private inputTokens = new Map<number, number>();
  /** 输入引脚 PinBus.onChange 订阅（电平变化 → wasm irq 注入），pin → 取消函数 */
  private irqUnsubs = new Map<number, () => void>();
  /** 串口发送队列（主线程 uart.tx 输入 → 固件 UART.read） */
  private rxQueue = new Map<number, number[]>();

  private lastCircuit: CircuitDoc | null = null;
  private lastFw: FirmwareInput | null = null;

  private setState(s: EngineStatus, error?: string): void {
    this.state = s;
    this.emit('state', { status: s, error });
  }

  private log(level: 'info' | 'warn' | 'error', text: string): void {
    this.emit('log', { level, text });
  }

  private emit<K extends EngineEventType>(type: K, payload: EngineEventMap[K]): void {
    const set = this.handlers.get(type);
    if (set) for (const cb of set) cb(payload);
  }

  memBytes(): number {
    return this.wasm ? this.wasm.mod.HEAPU8.buffer.byteLength : 0;
  }

  on<K extends EngineEventType>(type: K, cb: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(cb as Handler<EngineEventType>);
    return () => {
      set?.delete(cb as Handler<EngineEventType>);
      if (set && set.size === 0) this.handlers.delete(type);
    };
  }

  input(ev: InputEvent): void {
    switch (ev.type) {
      case 'pin.level':
        try {
          const ref = `${ev.partId}:${ev.pin}` as PinRef;
          // release（按键松开）：清除注入态，回退 pull/fixed 决定的电平（05-§1.4）
          if (ev.release) {
            this.bus.releasePin(ref);
          } else {
            this.bus.injectPin(ref, ev.level);
          }
        } catch (err) {
          this.log('warn', `输入注入失败：${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      case 'analog.value':
        try {
          this.bus.injectAnalog(`${ev.partId}:${ev.pin}` as PinRef, ev.value);
        } catch {
          this.log('warn', `模拟注入失败：未知引脚 ${ev.partId}:${ev.pin}`);
        }
        break;
      case 'uart.tx': {
        const q = this.rxQueue.get(ev.port ?? 0) ?? [];
        for (const b of ev.bytes) q.push(b);
        this.rxQueue.set(ev.port ?? 0, q);
        break;
      }
      case 'sensor.data':
        this.log('warn', 'sensor.data 输入 M8 支持（I2C/SPI 传感器）');
        break;
    }
  }

  async load(circuit: CircuitDoc, fw: FirmwareInput): Promise<void> {
    this.setState('loading');
    this.lastCircuit = circuit;
    this.lastFw = fw;

    // 1) 电路装载：板卡 GPIO 映射 + PinBus 网络聚合
    const boardPart = circuit.parts.find((p) => p.type === circuit.boardType);
    if (!boardPart) {
      this.setState('error', `电路缺少板卡实例（boardType=${circuit.boardType}）`);
      return;
    }
    this.setupCircuit(circuit);

    // 2) wasm 模块（首次装载；reset() 已重建则跳过）
    if (!this.wasm) {
      this.wasm = await loadMicroPython();
      this.registerShim(this.wasm);
    }

    // 3) VFS 写入（03-§3.3）
    const files =
      fw.kind === 'sources'
        ? fw.files
        : (() => {
            throw new Error('引擎A 仅接受源码输入（sources）；固件二进制走引擎B');
          })();
    const vfsOk = writeVfs(this.wasm.mod, files);
    if (!vfsOk) {
      this.log('warn', 'wasm 文件系统不可用，降级单文件执行（相对 import 不支持）');
    }

    this.setState('idle');
  }

  start(opts?: { speed?: 0.25 | 0.5 | 1 | 2 | 4 }): void {
    const wasm = this.wasm;
    if (!wasm || !this.lastFw) {
      this.setState('error', '引擎未装载：请先 load()');
      return;
    }
    if ((opts?.speed ?? 1) !== 1) {
      this.log('info', '引擎A 倍速调节 M5 支持（当前固定 1×）');
    }
    if (!wasm.caps.doExec) {
      this.setState('error', 'wasm 产物缺少执行入口（mp_js_do_exec 不可用）');
      return;
    }

    const files = this.lastFw.kind === 'sources' ? this.lastFw.files : [];
    const mainPy =
      files.find((f) => f.path === 'main.py' || f.path === '/main.py')?.content ?? null;
    if (mainPy === null) {
      this.setState('error', '缺少 main.py：请检查工程文件');
      return;
    }

    this.setState('running');
    // mp_js_do_exec 异步执行（v1.26 入口；Asyncify 驱动 time.sleep 挂起）。
    // while True 类脚本常驻 running；脚本结束/异常 → paused，traceback 走 stderr → 串口。
    queueMicrotask(() => {
      const mod = wasm.mod;
      try {
        const len = mod.lengthBytesUTF8(mainPy);
        const buf = mod._malloc(len + 1);
        mod.stringToUTF8(mainPy, buf, len + 1);
        const value = mod._malloc(3 * 4);
        const done = mod.ccall(
          'mp_js_do_exec',
          'number',
          ['pointer', 'number', 'pointer'],
          [buf, len, value],
          { async: true },
        ) as unknown as Promise<number>;
        void done.then(
          () => {
            mod._free(buf);
            mod._free(value);
            if (this.state === 'running') this.setState('paused');
          },
          (err: unknown) => {
            this.log('error', `执行中断：${err instanceof Error ? err.message : String(err)}`);
            if (this.state === 'running') this.setState('paused');
          },
        );
      } catch (err) {
        this.log('error', `执行中断：${err instanceof Error ? err.message : String(err)}`);
        if (this.state === 'running') this.setState('paused');
      }
    });
  }

  pause(): void {
    const wasm = this.wasm;
    if (this.state !== 'running' || !wasm) return;
    if (wasm.caps.interrupt) {
      wasm.mod._mp_sched_keyboard_interrupt?.();
      this.log('info', '已注入 KeyboardInterrupt');
    } else {
      this.log('warn', '停止中断不可用（产物未导出 mp_sched_keyboard_interrupt）；死循环请停止会话');
    }
  }

  async reset(): Promise<void> {
    if (!this.lastCircuit || !this.lastFw) return;
    // 重建 wasm 实例（干净全局状态）+ 重置电路状态（PinBus/token），VFS 重写，不自动 start
    this.setState('loading');
    this.wasm = await loadMicroPython();
    this.registerShim(this.wasm);
    this.setupCircuit(this.lastCircuit);
    if (this.lastFw.kind === 'sources') writeVfs(this.wasm.mod, this.lastFw.files);
    this.setState('idle');
  }

  /** 板卡 GPIO 映射 + PinBus 网络聚合 + 引脚 token 重置（load/reset 共用） */
  private setupCircuit(circuit: CircuitDoc): void {
    const boardPart = circuit.parts.find((p) => p.type === circuit.boardType);
    if (!boardPart) throw new Error(`电路缺少板卡实例（boardType=${circuit.boardType}）`);
    this.gpioRefs.clear();
    for (const pin of BOARD_DEF.pins) {
      // 左右列同名引脚重复出现 → 后写覆盖，PinRef 一致无影响
      this.gpioRefs.set(pin.gpio, `${boardPart.id}:${pin.name}` as PinRef);
    }
    for (const unsub of this.irqUnsubs.values()) unsub();
    this.irqUnsubs.clear();
    this.outputTokens.clear();
    this.inputTokens.clear();
    this.rxQueue.clear();
    this.bus.onWarn((text) => this.log('warn', text));
    this.bus.load(circuit, BOARD_DEF, P1_CATALOG as ReadonlyMap<string, PartDefinition>);
  }

  dispose(): void {
    for (const unsub of this.irqUnsubs.values()) unsub();
    this.irqUnsubs.clear();
    this.setState('idle');
    this.handlers.clear();
  }

  /**
   * 输入引脚电平变化 → wasm 注入（M5 irq 链路）：
   * PinBus.onChange（网络级）→ mp_js_gpio_inject(pin, level) → mp_sched_schedule 回调。
   * 产物缺少导出（旧 wasm）时仅告警一次，轮询式 Pin.value() 读取不受影响。
   */
  private subscribeIrq(pin: number, ref: PinRef): void {
    if (this.irqUnsubs.has(pin)) return;
    const inject = this.wasm?.mod._mp_js_gpio_inject;
    if (!inject) {
      this.log('warn', 'wasm 产物缺少 mp_js_gpio_inject（旧产物），Pin.irq 不可用');
      return;
    }
    const unsub = this.bus.onChange(ref, (level) => inject(pin, level));
    this.irqUnsubs.set(pin, unsub);
  }

  // ---- machine shim JS 桥（machine.c EM_JS 回调，见 03-§3.2 转发表） ----

  private registerShim(wasm: LoadedMpy): void {
    const bridge = {
      gpioWrite: (pin: number, level: number): void => {
        const ref = this.gpioRefs.get(pin);
        if (!ref) {
          this.log('warn', `Pin(${pin}) 不在板卡引脚表内，忽略写入`);
          return;
        }
        let token = this.outputTokens.get(pin);
        if (token === undefined) {
          token = this.bus.claimOutput(ref);
          this.outputTokens.set(pin, token);
        }
        this.bus.write(token, level ? 1 : 0);
        this.seq.gpio += 1;
        this.emit('gpio.write', { pin, level: level ? 1 : 0, seq: this.seq.gpio });
      },
      gpioRead: (pin: number): number => {
        const ref = this.gpioRefs.get(pin);
        if (!ref) return 0;
        if (!this.outputTokens.has(pin) && !this.inputTokens.has(pin)) {
          this.inputTokens.set(pin, this.bus.claimInput(ref, 'none'));
        }
        return this.bus.read(ref) as Level;
      },
      // Pin(n, Pin.IN, pull) make_new 上报（machine.c js_gpio_configure）：
      // 注册输入读者 + pull 语义 + 订阅电平变化回注 wasm（irq 触发）
      gpioConfigure: (pin: number, mode: number, pull: number): void => {
        const ref = this.gpioRefs.get(pin);
        if (!ref || mode !== 0) return; // 仅输入模式需要注册
        if (this.inputTokens.has(pin) || this.outputTokens.has(pin)) return;
        this.inputTokens.set(pin, this.bus.claimInput(ref, PULL_BY_CONST[pull] ?? 'none'));
        this.subscribeIrq(pin, ref);
      },
      uartWrite: (port: number, bytes: Uint8Array): void => {
        const p = (port >= 0 && port <= 2 ? port : 0) as 0 | 1 | 2;
        this.emit('uart.rx', { bytes, port: p });
      },
      uartRead: (port: number, maxlen: number): Uint8Array | null => {
        const q = this.rxQueue.get(port);
        if (!q || q.length === 0) return null;
        const n = Math.min(q.length, maxlen);
        const out = new Uint8Array(q.splice(0, n));
        return out;
      },
      uartAvailable: (port: number): number => this.rxQueue.get(port)?.length ?? 0,
      pwmWrite: (pin: number, duty: number, freq: number): void => {
        const ref = this.gpioRefs.get(pin);
        if (!ref) {
          this.log('warn', `PWM pin ${pin} 不在板卡引脚表内，忽略`);
          return;
        }
        const clampedDuty = Math.max(0, Math.min(1023, duty));
        const clampedFreq = Math.max(1, freq);
        this.bus.pwm(ref, clampedDuty, clampedFreq);
        this.emit('pwm.duty', { pin, duty: clampedDuty, freq: clampedFreq });
      },
      adcRead: (pin: number): number => {
        const ref = this.gpioRefs.get(pin);
        if (!ref) return 0;
        return this.bus.adcRead(ref) ?? 0;
      },
    };
    (globalThis as unknown as Record<string, unknown>).__mpyMachine = bridge;

    // stdout → uart.rx port 0（print 每行，补回换行）
    wasm.onStdout((line) => {
      this.emit('uart.rx', { bytes: new TextEncoder().encode(line + '\n'), port: 0 });
    });
    wasm.onStderr((line) => {
      this.emit('uart.rx', { bytes: new TextEncoder().encode(line + '\n'), port: 0 });
      this.log('error', line);
    });
  }
}
