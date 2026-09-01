import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type net from 'node:net';
import { join } from 'node:path';
import type {
  CircuitDoc,
  DhtDeviceSpec,
  I2cDeviceSpec,
  NeopixelDeviceSpec,
  OledDeviceSpec,
  SpiDeviceSpec,
} from '@esp32-sim/shared';
import { clientMsgSchema, type ClientMsg, type ServerMsg } from '@esp32-sim/shared';
import type { AppConfig } from '../config/schema';
import type { Db } from '../db/client';
import { QemuGpioBridge, pullOfMode } from '../services/gpio.bridge';
import type { BuildService } from '../services/build.service';
import type { QemuManager } from '../services/qemu.manager';
import { notFound } from '../utils/http-error';

/**
 * WS 会话网关（03-§7.3 状态机 + §7.4 编译进度通道）
 *
 * 状态机：attaching → building-wait → running ⇄ paused(M4 不支持) → error → closed
 * - attach：build success 直接 spawn QEMU；queued/running 订阅进度；无记录触发新编译；
 * - build.progress：普通行 100ms 窗口聚合 logLines；critical 行（error/warning）立即 logLine；
 * - 心跳（06-§7.1.1 N20）：ws ping frame + 应用层 ping 消息（不计速率）；45s 未 pong → terminate；
 * - 断线保留 reconnectGraceMs（60s）供同 sid 重连，超时回收 QEMU；
 * - 速率：config.ws.msgRateLimitPerSec（超限 error.ack + 断开）；
 * - GPIO 桥（M5）：第二 serial ⇄ QemuGpioBridge；固件 gpio.write 帧 → ws 事件；
 *   ws input.pin → 元件引脚映射板卡 GPIO → 桥注入（release 回退 pull 语义，05-§1.4）。
 */

interface GwSession {
  sid: string;
  state: 'attaching' | 'building-wait' | 'running' | 'paused' | 'error' | 'closed';
  socket: WebSocket | null;
  projectId: string | null;
  circuit: CircuitDoc | null;
  firmwareId: string | null;
  boardType: string | null;
  qemuSessionId: string | null;
  serialSocket: net.Socket | null;
  /** GPIO 桥（M5）：第二 serial 连接 + 帧编解码 */
  gpioSocket: net.Socket | null;
  bridge: QemuGpioBridge | null;
  /** gpio.write 事件单调序号 */
  gpioSeq: number;
  /** M8 i2c.txn / spi.txn 事件单调序号 */
  i2cSeq: number;
  spiSeq: number;
  /** M8 后续：DHT22 请求事件单调序号 */
  dhtSeq: number;
  /** M9：fb.update / neopixel.write 事件单调序号 */
  fbSeq: number;
  neopixelSeq: number;
  /** 固件上报的 pull 语义（PIN_MODE 帧）→ release 回退电平 */
  pinPull: Map<number, 0 | 1>;
  /** 引脚邻接表（attach 时由 circuit 构建，input.pin 映射板卡 GPIO 用） */
  adj: Map<string, string[]> | null;
  /** 板卡 part 的 id（电路中 type = board-<boardType> 的 part） */
  boardPartId: string | null;
  /** M8 设备表：addr → I2C 设备语义（attach 时由 circuit + parts_catalog 构建） */
  i2cDevices: Map<number, I2cDeviceSpec>;
  /** M8 设备表：csGpio → SPI 设备语义 */
  spiDevices: Map<number, SpiDeviceSpec>;
  /** M8 后续：DHT22 等 env-sensor → 运行时 pin 映射 + 默认值 */
  dhtDevices: Map<number, { partId: string; temp: number; humidity: number }>;
  /** M9 设备表：I2C addr → OLED part（FB_TXN 帧 → fb.update 定位渲染元件） */
  oledDevices: Map<number, string>;
  /** M9 设备表：GPIO → NeoPixel part（NEOPIXEL_WRITE 帧 → neopixel.write） */
  neopixelPins: Map<number, string>;
  /** 固件 panic 扫描缓冲（串口文本尾部窗口，防关键词跨 chunk 切断） */
  panicTail: string;
  /** 本会话 panic 自动重启次数（上限 1 次；ctrl reset / 重新 attach 归零） */
  panicRetries: number;
  unsubBuild: (() => void) | null;
  graceTimer: NodeJS.Timeout | null;
  lifeTimer: NodeJS.Timeout;
  createdAt: number;
  alive: boolean;
  /** 速率窗口 */
  rateCount: number;
  rateWindowStart: number;
}

const CRITICAL_LINE = /\b(error|warning|fatal|失败)\b/i;

/** 固件 panic 检出（与 golden/runner.ts PANIC_RE 同源：QEMU Espressif fork 双核缓存仿真 flake，06-§3） */
const PANIC_RE = /Guru Meditation/i;

export interface WsGatewayOptions {
  config: AppConfig;
  db: Db;
  builds: BuildService;
  qemu: QemuManager;
}

export async function wsGatewayRoutes(
  fastify: FastifyInstance,
  opts: WsGatewayOptions,
): Promise<void> {
  const { config, builds, qemu, db } = opts;
  const sessions = new Map<string, GwSession>();

  // ---- QEMU 非正常退出 → 会话 error（网关 unaware 的进程崩溃兜底） ----
  qemu.onExit((qemuSid, code, signal) => {
    const s = [...sessions.values()].find((x) => x.qemuSessionId === qemuSid);
    if (!s || s.state === 'closed') return;
    detachSerial(s);
    detachBridge(s);
    s.qemuSessionId = null;
    const msg = `QEMU 进程退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`;
    setState(s, 'error', msg);
    sendErr(s, 'QEMU_EXIT', msg);
  });

  // ---- 心跳：ping frame + 失联判定（06-§7.1.1） ----
  const hb = setInterval(() => {
    for (const s of sessions.values()) {
      if (!s.socket) continue;
      if (!s.alive) {
        s.socket.terminate();
        continue;
      }
      s.alive = false;
      s.socket.ping();
    }
  }, config.ws.heartbeatIntervalMs);
  hb.unref();

  // ---- WS /ws/sim/:sid ----
  fastify.get('/ws/sim/:sid', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const { sid } = req.params as { sid: string };

    // 重连：同 sid 接管（running 会话的 QEMU 仍在运行）
    const existing = sessions.get(sid);
    if (existing && existing.state !== 'closed') {
      if (existing.socket) {
        socket.close(4000, 'session already attached');
        return;
      }
      clearTimeout(existing.graceTimer ?? undefined);
      existing.graceTimer = null;
      existing.socket = socket;
      existing.alive = true;
      bindSocket(existing, socket);
      send(existing, { type: 'state', payload: { status: existing.state } });
      return;
    }

    const s: GwSession = {
      sid,
      state: 'attaching',
      socket,
      projectId: null,
      circuit: null,
      firmwareId: null,
      boardType: null,
      qemuSessionId: null,
      serialSocket: null,
      gpioSocket: null,
      bridge: null,
      gpioSeq: 0,
      i2cSeq: 0,
      spiSeq: 0,
      dhtSeq: 0,
      fbSeq: 0,
      neopixelSeq: 0,
      pinPull: new Map(),
      adj: null,
      boardPartId: null,
      i2cDevices: new Map(),
      spiDevices: new Map(),
      dhtDevices: new Map(),
      oledDevices: new Map(),
      neopixelPins: new Map(),
      panicTail: '',
      panicRetries: 0,
      unsubBuild: null,
      graceTimer: null,
      lifeTimer: setTimeout(() => {
        void destroySession(s, 'session lifetime exceeded');
      }, config.ws.sessionMaxLifetimeMs),
      createdAt: Date.now(),
      alive: true,
      rateCount: 0,
      rateWindowStart: Date.now(),
    };
    s.lifeTimer.unref();
    bindSocket(s, socket);
    sessions.set(sid, s);
  });

  // ---- REST：会话状态查询 / 指标（01-§5.2） ----
  fastify.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = sessions.get(id);
    if (!s) throw notFound(`会话不存在或已回收：${id}`);
    return await reply.send({
      id: s.sid,
      state: s.state,
      projectId: s.projectId,
      firmwareId: s.firmwareId,
      qemuSessionId: s.qemuSessionId,
      createdAt: s.createdAt,
    });
  });

  fastify.get('/api/metrics/sessions', async (_req, reply) => {
    const byState: Record<string, number> = {};
    for (const s of sessions.values()) byState[s.state] = (byState[s.state] ?? 0) + 1;
    return await reply.send({ total: sessions.size, byState });
  });

  // ---- 内部：消息处理 ----

  function bindSocket(s: GwSession, socket: WebSocket): void {
    socket.on('message', (raw: Buffer) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        sendErr(s, 'BAD_JSON', '消息不是合法 JSON');
        return;
      }
      const parsed = clientMsgSchema.safeParse(json);
      if (!parsed.success) {
        sendErr(s, 'VALIDATION_FAILED', `消息校验失败：${parsed.error.issues[0]?.message ?? ''}`);
        return;
      }
      const msg = parsed.data as ClientMsg;
      // 心跳不计入速率上限（06-§7.1.1）
      if (msg.type === 'ping') {
        s.alive = true;
        send(s, { type: 'pong', ts: Date.now() });
        return;
      }
      if (!checkRate(s)) return;
      void handleMessage(s, msg);
    });
    socket.on('pong', () => {
      s.alive = true;
    });
    socket.on('close', () => {
      s.socket = null;
      // 断线保留 grace（06-§4：60s 重连窗口），超时回收
      s.graceTimer = setTimeout(() => {
        void destroySession(s, 'reconnect grace expired');
      }, config.flash.reconnectGraceMs);
      s.graceTimer.unref();
    });
    socket.on('error', () => {
      socket.terminate();
    });
  }

  function checkRate(s: GwSession): boolean {
    const now = Date.now();
    if (now - s.rateWindowStart > 1000) {
      s.rateWindowStart = now;
      s.rateCount = 0;
    }
    s.rateCount += 1;
    if (s.rateCount > config.ws.msgRateLimitPerSec) {
      sendErr(s, 'RATE_LIMITED', `消息速率超限（>${config.ws.msgRateLimitPerSec}/s）`);
      s.socket?.close(1008, 'rate limited');
      return false;
    }
    return true;
  }

  async function handleMessage(s: GwSession, msg: ClientMsg): Promise<void> {
    switch (msg.type) {
      case 'attach':
        return void onAttach(s, msg.payload);
      case 'ctrl':
        return void onCtrl(s, msg.payload);
      case 'input.uart':
        return onInputUart(s, msg.payload.bytes);
      case 'input.pin':
        return onInputPin(s, msg.payload);
      case 'input.analog':
        return onInputAnalog(s, msg.payload);
      default:
        sendErr(s, 'UNSUPPORTED', `${msg.type} 暂未支持`);
    }
  }

  function onAttach(
    s: GwSession,
    p: { projectId: string; circuit: CircuitDoc; firmwareId: string; boardType: string },
  ): void {
    if (s.state !== 'attaching' && s.state !== 'error') {
      sendErr(s, 'INVALID_STATE', `attach 仅在 attaching/error 状态有效（当前 ${s.state}）`);
      return;
    }
    s.projectId = p.projectId;
    s.circuit = p.circuit;
    s.firmwareId = p.firmwareId;
    // boardType 规范化为短名（前端 session-client 直传 CircuitDoc.boardType 带 board-
    // 前缀，golden runner 传短名；下游 BOARD_MACHINE/board_pinmaps/board-${bt} 匹配
    // 均按短名语义，入口统一 strip，避免 boardPartId 双前缀匹配失败 → input.pin 全部
    // NO_GPIO（M7 浏览器端实测发现，golden 因传短名未触发））
    s.boardType = p.boardType.replace(/^board-/, '');
    // M5 GPIO 桥：邻接表 + 板卡 part 识别（input.pin 映射板卡 GPIO 用）
    s.adj = buildAdjacency(p.circuit);
    s.boardPartId =
      p.circuit.parts.find((part) => part.type === `board-${s.boardType}`)?.id ?? null;
    s.pinPull = new Map();
    // M8 I2C/SPI/DHT22 设备表：扫描 circuit.parts 中带 simulator.device 的元件
    s.i2cDevices = new Map();
    s.spiDevices = new Map();
    s.dhtDevices = new Map();
    s.oledDevices = new Map();
    s.neopixelPins = new Map();
    buildDeviceTables(s, p.circuit);
    setState(s, 'attaching');
    resolveBuild(s);
  }

  /**
   * M8/M9 设备表构建：遍历 circuit.parts 查 parts_catalog，收集 simulator.device
   *（i2c-device / spi-device / env-sensor / oled-device / neopixel-device）；
   * 网关在 onI2cTxn/onSpiTxn/onDhtTxn/onFbTxn/onNeopixelWrite 时查表回复或定位元件。
   */
  function buildDeviceTables(s: GwSession, circuit: CircuitDoc): void {
    const stmt = db.prepare('SELECT definition_json FROM parts_catalog WHERE type = ?');
    for (const part of circuit.parts) {
      const row = stmt.get(part.type) as { definition_json: string } | undefined;
      if (!row) continue;
      let def: {
        simulator?: { device?: unknown };
        pins?: { name: string; role?: string }[];
      };
      try {
        def = JSON.parse(row.definition_json) as typeof def;
      } catch {
        continue;
      }
      const dev = def.simulator?.device;
      if (!dev) continue;
      const d = dev as
        I2cDeviceSpec | SpiDeviceSpec | DhtDeviceSpec | OledDeviceSpec | NeopixelDeviceSpec;
      if (d.kind === 'i2c-device') {
        s.i2cDevices.set(d.address, d);
      } else if (d.kind === 'spi-device') {
        s.spiDevices.set(d.csGpio, d);
      } else if (d.kind === 'env-sensor') {
        /* 运行时 pin 映射：从 parts_catalog.pins 找 role='signal.io' 的 pin name */
        const signalPinName = def.pins?.find((p) => p.role === 'signal.io')?.name;
        if (!signalPinName) continue;
        const gpio = resolveGpio(s, part.id, signalPinName);
        if (gpio === null) continue;
        /* attrs 覆盖 defaults */
        const temp =
          typeof part.attrs.temperature === 'number'
            ? (part.attrs.temperature as number)
            : (d.defaults?.temperature ?? 22);
        const humidity =
          typeof part.attrs.humidity === 'number'
            ? (part.attrs.humidity as number)
            : (d.defaults?.humidity ?? 50);
        s.dhtDevices.set(gpio, { partId: part.id, temp, humidity });
      } else if (d.kind === 'oled-device') {
        /* M9：attrs.i2cAddr（"0x3C"/"0x3D"）覆盖 spec.address */
        const attr = part.attrs['i2cAddr'];
        const addr =
          typeof attr === 'string' && attr.startsWith('0x') ? parseInt(attr, 16) : d.address;
        s.oledDevices.set(addr, part.id);
      } else if (d.kind === 'neopixel-device') {
        /* M9：DIN 信号脚 → 板卡 GPIO 映射（NEOPIXEL_WRITE 帧按 pin 定位元件） */
        const signalPinName = def.pins?.find((p) => p.role === 'signal.io')?.name;
        if (!signalPinName) continue;
        const gpio = resolveGpio(s, part.id, signalPinName);
        if (gpio === null) continue;
        s.neopixelPins.set(gpio, part.id);
      }
    }
  }

  /**
   * M8 I2C 回复计算：根据 wdata[0]（register addr）查寄存器语义，
   * 返回 defaultBytes 或按 size 填 0（无设备/无寄存器 → 空数组 NACK 语义）。
   * 注：协议未传 reqLen（requestFrom 期望字节数），按寄存器 spec.size 回复；
   * glue 端 rbuf 容量由 shim 传入的 rlen_cap 截断，少于 spec 时返回 rlen_cap 字节。
   */
  function computeI2cReply(device: I2cDeviceSpec | undefined, wdata: Uint8Array): Uint8Array {
    if (!device) return new Uint8Array(0); // NACK
    const regAddr = wdata[0];
    const reg =
      regAddr === undefined ? undefined : device.registers.find((r) => r.addr === regAddr);
    if (!reg) return new Uint8Array(0); // 未知寄存器 → NACK
    const size = Math.min(reg.size, 255);
    if (reg.defaultBytes && reg.defaultBytes.length >= size) {
      return new Uint8Array(reg.defaultBytes.slice(0, size));
    }
    return new Uint8Array(size); // 全 0（decode='whoami' 等可由前端覆盖）
  }

  /**
   * M8 SPI 回复计算：全双工语义，回复字节数 = wdata 长度；
   * 有 registers 时按 wdata[0] 命令字查 defaultBytes 截取。
   */
  function computeSpiReply(device: SpiDeviceSpec | undefined, wdata: Uint8Array): Uint8Array {
    if (!device?.registers || device.registers.length === 0) {
      // 无寄存器语义：回 0（SPI 幻象 echo 由 glue shim 阻断，不再发生）
      return new Uint8Array(wdata.length);
    }
    const regAddr = wdata[0];
    const reg =
      regAddr === undefined ? undefined : device.registers.find((r) => r.addr === regAddr);
    if (!reg) return new Uint8Array(wdata.length);
    const size = Math.min(reg.size, wdata.length);
    if (reg.defaultBytes && reg.defaultBytes.length >= size) {
      return new Uint8Array(reg.defaultBytes.slice(0, size));
    }
    return new Uint8Array(size);
  }

  /** build 状态分流（§7.3：success→spawn；queued/running→building-wait；无→submit；failed→error） */
  function resolveBuild(s: GwSession): void {
    const firmwareId = s.firmwareId;
    if (!firmwareId || !s.boardType) return;
    const rec = builds.status(firmwareId);

    if (!rec) {
      // 无记录：触发新编译（需 projectId）
      if (!s.projectId) {
        setState(s, 'error', 'attach 缺少 projectId，无法发起编译');
        return;
      }
      try {
        const { buildId } = builds.submit(s.projectId, 'arduino');
        s.firmwareId = buildId;
      } catch (err) {
        setState(s, 'error', err instanceof Error ? err.message : String(err));
        return;
      }
      enterBuildingWait(s);
      return;
    }

    if (rec.status === 'success') {
      void spawnQemuFor(s);
      return;
    }
    if (rec.status === 'failed') {
      const tail = (rec.log ?? '').split('\n').slice(-3).join('\n');
      setState(s, 'error', `编译失败：${tail}`);
      return;
    }
    enterBuildingWait(s);
  }

  function enterBuildingWait(s: GwSession): void {
    const buildId = s.firmwareId;
    if (!buildId) return;
    setState(s, 'building-wait');
    s.unsubBuild?.();
    let pendingLines: string[] = [];
    let flushTimer: NodeJS.Timeout | null = null;

    const flush = (): void => {
      flushTimer = null;
      if (!pendingLines.length) return;
      send(s, {
        type: 'build.progress',
        payload: { buildId, phase: 'compiling', progress: lastProgress, logLines: pendingLines },
      });
      pendingLines = [];
    };
    let lastProgress = 0;

    s.unsubBuild = builds.onEvent((evBuildId, ev) => {
      if (evBuildId !== buildId) return;
      if (s.state !== 'building-wait') return;

      if (ev.kind === 'log' && ev.line !== undefined) {
        lastProgress = ev.progress ?? lastProgress;
        if (CRITICAL_LINE.test(ev.line)) {
          // critical 行立即推送，不进聚合窗口（§7.4）
          send(s, {
            type: 'build.progress',
            payload: { buildId, phase: 'compiling', progress: lastProgress, logLine: ev.line },
          });
          return;
        }
        pendingLines.push(ev.line);
        if (!flushTimer) {
          flushTimer = setTimeout(flush, 100);
          flushTimer.unref();
        }
        return;
      }

      if (ev.kind === 'phase' && ev.phase) {
        clearTimeout(flushTimer ?? undefined);
        flushTimer = null;
        pendingLines = [];
        send(s, {
          type: 'build.progress',
          payload: {
            buildId,
            phase: ev.phase,
            progress: ev.progress ?? 1,
            error: ev.error,
          },
        });
        if (ev.phase === 'success') void spawnQemuFor(s);
        if (ev.phase === 'failed') {
          setState(s, 'error', `编译失败：${ev.error ?? 'unknown'}`);
        }
      }
    });

    // 已入队但订阅晚于早期事件：补一条当前状态
    const rec = builds.status(buildId);
    if (rec) {
      send(s, {
        type: 'build.progress',
        payload: {
          buildId,
          phase: rec.status === 'queued' ? 'queued' : 'compiling',
          progress: 0,
        },
      });
    }
  }

  async function spawnQemuFor(s: GwSession): Promise<void> {
    const firmwareId = s.firmwareId;
    if (!firmwareId || !s.boardType) return;
    const rec = builds.status(firmwareId);
    if (!rec || !rec.artifact) {
      setState(s, 'error', 'build 无产物（flash.img 缺失）');
      return;
    }
    // 旧实例清理（ctrl reset respawn 路径）
    if (s.qemuSessionId) {
      detachSerial(s);
      await qemu.dispose(s.qemuSessionId, 'respawn');
      s.qemuSessionId = null;
    }
    try {
      const { sessionId } = await qemu.spawnSession({
        firmwarePath: join(builds.buildDir(firmwareId), rec.artifact),
        boardType: s.boardType,
      });
      s.qemuSessionId = sessionId;
      const serial = await qemu.connectSerial(sessionId);
      s.serialSocket = serial;
      s.panicTail = '';
      serial.on('data', (chunk: Buffer) => {
        send(s, { type: 'uart.rx', payload: { bytes: [...chunk] } });
        scanFirmwarePanic(s, chunk);
      });
      serial.on('close', () => {
        if (s.serialSocket === serial) s.serialSocket = null;
      });
      serial.on('error', (err) => {
        send(s, {
          type: 'log',
          payload: { level: 'warn', text: `串口连接异常：${err.message}` },
        });
      });
      attachGpioBridge(s, sessionId);
      setState(s, 'running');
    } catch (err) {
      setState(s, 'error', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 固件 panic 扫描（06-§3 QEMU flake 缓解的浏览器会话口径，与 golden runner 同策略）：
   * QEMU Espressif fork 双核缓存仿真存在 flake——固件启动后偶发 "Guru Meditation:
   * Cache error" panic。检出即换新 QEMU 会话自动重启一次（用户仅收到 log 提示），
   * 连续第二次 panic 判会话 error。ctrl reset / 重新 attach 重置计数。
   */
  function scanFirmwarePanic(s: GwSession, chunk: Buffer): void {
    if (s.state === 'closed' || s.state === 'error') return;
    // latin1：字节级保真（boot 日志为 ASCII，不做 UTF-8 多字节合并）
    s.panicTail = (s.panicTail + chunk.toString('latin1')).slice(-64);
    if (!PANIC_RE.test(s.panicTail)) return;
    // 命中即停扫（respawn 为异步，防止后续 chunk 重复触发）
    s.panicTail = '';
    detachSerial(s);
    s.panicRetries += 1;
    if (s.panicRetries > 1) {
      const msg =
        '固件 panic 连续复现（QEMU 双核缓存仿真偶发 flake），已停止自动重启，请点击 ⟳ 重试';
      setState(s, 'error', msg);
      sendErr(s, 'FIRMWARE_PANIC', msg);
      return;
    }
    send(s, {
      type: 'log',
      payload: {
        level: 'warn',
        text: '检测到固件 panic（QEMU 双核缓存仿真偶发 flake），自动重启仿真会话…',
      },
    });
    void spawnQemuFor(s);
  }

  /** GPIO 桥接线（M5/M7）：桥断开不致会话失败（串口监视仍可用），仅告警 */
  function attachGpioBridge(s: GwSession, sessionId: string): void {
    detachBridge(s);
    s.gpioSeq = 0;
    void qemu
      .connectGpioSerial(sessionId)
      .then((gpioSocket) => {
        // spawn 失败/会话已关时丢弃连接
        if (s.qemuSessionId !== sessionId) {
          gpioSocket.destroy();
          return;
        }
        s.gpioSocket = gpioSocket;
        s.bridge = new QemuGpioBridge(gpioSocket, {
          onGpioWrite: (pin, level) => {
            s.gpioSeq += 1;
            send(s, { type: 'gpio.write', payload: { pin, level, seq: s.gpioSeq } });
          },
          onPinMode: (pin, mode) => {
            const pull = pullOfMode(mode);
            if (pull === null) s.pinPull.delete(pin);
            else s.pinPull.set(pin, pull);
          },
          onPwmWrite: (pin, duty) => {
            const freq = s.bridge?.getFreq(pin) ?? 1000;
            send(s, { type: 'pwm.duty', payload: { pin, duty, freq } });
          },
          onPwmFreq: (_pin, _freq) => {
            /* freq 由 bridge.freqOfPin 跟踪，onPwmWrite 时组合上报 */
          },
          onI2cTxn: (ev) => {
            s.i2cSeq += 1;
            send(s, {
              type: 'i2c.txn',
              payload: {
                addr: ev.addr,
                dir: ev.dir,
                data: Array.from(ev.data),
                seq: s.i2cSeq,
              },
            });
            // 计算回复：dir='w' 回 0 字节（解开 glue 阻塞），dir='r' 查寄存器语义
            const device = s.i2cDevices.get(ev.addr);
            const reply = ev.dir === 'r' ? computeI2cReply(device, ev.data) : new Uint8Array(0);
            s.bridge?.sendI2cReply(ev.addr, reply);
          },
          onSpiTxn: (ev) => {
            s.spiSeq += 1;
            send(s, {
              type: 'spi.txn',
              payload: { cs: ev.cs, data: Array.from(ev.data), seq: s.spiSeq },
            });
            const device = s.spiDevices.get(ev.cs);
            const reply = computeSpiReply(device, ev.data);
            s.bridge?.sendSpiReply(ev.cs, reply);
          },
          /** M8 后续：DHT22 单总线请求 —— 查 dhtDevices 回复 */
          onDhtTxn: (ev) => {
            s.dhtSeq += 1;
            const device = s.dhtDevices.get(ev.pin);
            if (device) {
              const tempRaw = Math.round(device.temp * 10);
              const humRaw = Math.round(device.humidity * 10);
              send(s, {
                type: 'sensor.data',
                payload: {
                  partId: device.partId,
                  data: { temperature: device.temp, humidity: device.humidity },
                  gpio: ev.pin,
                  seq: s.dhtSeq,
                },
              });
              s.bridge?.sendDhtReply(ev.pin, tempRaw, humRaw);
            } else {
              /* 未配置的 pin：回复 0（255.1℃，-1.0%），避免 glue 超时死锁 */
              s.bridge?.sendDhtReply(ev.pin, 0, 0);
            }
          },
          /** M9：SSD1306 framebuffer 增量帧 —— 查 oledDevices → fb.update 单向推送 */
          onFbTxn: (ev) => {
            const partId = s.oledDevices.get(ev.addr);
            if (!partId) return; // 电路中无对应 OLED 元件：丢弃（不影响固件）
            s.fbSeq += 1;
            send(s, {
              type: 'fb.update',
              payload: {
                partId,
                rect: [ev.x, ev.y, ev.w, ev.h],
                data: Array.from(ev.data),
                seq: s.fbSeq,
              },
            });
          },
          /** M9：NeoPixel 像素帧 —— 查 neopixelPins → neopixel.write（GRB→RGB 归一） */
          onNeopixelWrite: (ev) => {
            const partId = s.neopixelPins.get(ev.pin);
            if (!partId) return;
            s.neopixelSeq += 1;
            const pixels: number[] = [];
            for (let i = 0; i + 2 < ev.data.length; i += 3) {
              /* glue 上报 WS2812 原生 GRB 顺序；WS 层统一 RGB（06-§3） */
              pixels.push(ev.data[i + 1] ?? 0, ev.data[i] ?? 0, ev.data[i + 2] ?? 0);
            }
            send(s, {
              type: 'neopixel.write',
              payload: { partId, pin: ev.pin, pixels, seq: s.neopixelSeq },
            });
          },
        });
        gpioSocket.on('close', () => {
          if (s.gpioSocket === gpioSocket) {
            s.gpioSocket = null;
            s.bridge = null;
          }
        });
        gpioSocket.on('error', () => {
          gpioSocket.destroy();
        });
      })
      .catch((err: unknown) => {
        if (s.state === 'running') {
          send(s, {
            type: 'log',
            payload: {
              level: 'warn',
              text: `GPIO 桥不可用（${err instanceof Error ? err.message : String(err)}），Pin 输入注入暂不可用`,
            },
          });
        }
      });
  }

  function onCtrl(s: GwSession, cmd: 'start' | 'pause' | 'reset' | 'stop'): void {
    const qemuSid = s.qemuSessionId;
    switch (cmd) {
      case 'start':
        if (s.state !== 'running' && s.state !== 'paused') {
          sendErr(s, 'INVALID_STATE', `start 仅在 running/paused 有效（当前 ${s.state}）`);
          return;
        }
        if (qemuSid) qemu.touch(qemuSid);
        setState(s, 'running');
        return;
      case 'pause':
        // M4：Windows 无 SIGSTOP 语义，QEMU 不可暂停（文档 03-§7.3 已注明）
        sendErr(s, 'UNSUPPORTED', '引擎B 暂停在 M4（Windows）不支持');
        return;
      case 'reset': {
        if (s.state !== 'running' && s.state !== 'paused' && s.state !== 'error') {
          sendErr(s, 'INVALID_STATE', `reset 仅在运行/错误状态有效（当前 ${s.state}）`);
          return;
        }
        s.panicRetries = 0; // 用户主动重试：重置 panic 自动重启计数
        setState(s, 'attaching');
        void spawnQemuFor(s).then(() => {
          if (s.state === 'attaching') setState(s, 'running');
        });
        return;
      }
      case 'stop':
        void destroySession(s, 'ctrl stop');
        return;
    }
  }

  function onInputUart(s: GwSession, bytes: number[]): void {
    if (s.state !== 'running' && s.state !== 'paused') {
      sendErr(s, 'INVALID_STATE', '引擎未运行，串口输入被丢弃');
      return;
    }
    const serial = s.serialSocket;
    if (!serial) {
      sendErr(s, 'NO_SERIAL', '串口未连接');
      return;
    }
    if (s.qemuSessionId) qemu.touch(s.qemuSessionId);
    serial.write(Buffer.from(bytes));
  }

  /**
   * 引脚输入注入（M5，05-§1.4）：partId/pin → 板卡 GPIO（沿连接 BFS）→ 桥注入；
   * release（按键松开）忽略 level，回退固件 pull 语义（无记录按 0）。
   */
  function onInputPin(
    s: GwSession,
    p: { partId: string; pin: string; level: 0 | 1; release?: boolean },
  ): void {
    if (s.state !== 'running' && s.state !== 'paused') {
      sendErr(s, 'INVALID_STATE', '引擎未运行，输入注入被丢弃');
      return;
    }
    if (s.qemuSessionId) qemu.touch(s.qemuSessionId);
    const bridge = s.bridge;
    if (!bridge) {
      sendErr(s, 'NO_GPIO_BRIDGE', 'GPIO 桥未连接');
      return;
    }
    const gpio = resolveGpio(s, p.partId, p.pin);
    if (gpio === null) {
      sendErr(s, 'NO_GPIO', `引脚 ${p.partId}:${p.pin} 未连接到板卡 GPIO`);
      return;
    }
    const level: 0 | 1 = p.release ? (s.pinPull.get(gpio) ?? 0) : p.level;
    bridge.injectInput(gpio, level);
  }

  /**
   * 模拟值注入（M7 ADC 桥）：partId/pin → 板卡 ADC 功能 GPIO → 桥注入；
   * 目标 GPIO caps 不含 'adc' 时报 ADC_PIN_INVALID 错误。
   */
  function onInputAnalog(s: GwSession, p: { partId: string; pin: string; value: number }): void {
    if (s.state !== 'running' && s.state !== 'paused') {
      sendErr(s, 'INVALID_STATE', '引擎未运行，模拟注入被丢弃');
      return;
    }
    if (s.qemuSessionId) qemu.touch(s.qemuSessionId);
    const bridge = s.bridge;
    if (!bridge) {
      sendErr(s, 'NO_GPIO_BRIDGE', 'GPIO 桥未连接');
      return;
    }
    const gpio = resolveGpioAdc(s, p.partId, p.pin);
    if (gpio === null) {
      sendErr(s, 'ADC_PIN_INVALID', `引脚 ${p.partId}:${p.pin} 未连接到板卡 ADC 功能脚`);
      return;
    }
    bridge.injectAnalog(gpio, p.value);
  }

  /** 元件引脚 → 板卡 GPIO：板卡引脚直查 pinmap；元件引脚沿连接 BFS 找板卡引脚（普通 GPIO） */
  function resolveGpio(s: GwSession, partId: string, pinName: string): number | null {
    if (!s.boardPartId || !s.boardType) return null;
    if (partId === s.boardPartId) return gpioOf(s.boardType, pinName);

    const start = `${partId}:${pinName}`;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const nxt of s.adj?.get(cur) ?? []) {
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        const idx = nxt.indexOf(':');
        if (nxt.slice(0, idx) === s.boardPartId) {
          return gpioOf(s.boardType, nxt.slice(idx + 1));
        }
        queue.push(nxt);
      }
    }
    return null;
  }

  /** 元件引脚 → 板卡 ADC GPIO：同 resolveGpio 路径，但要求目标引脚 caps 含 'adc' */
  function resolveGpioAdc(s: GwSession, partId: string, pinName: string): number | null {
    if (!s.boardPartId || !s.boardType) return null;
    if (partId === s.boardPartId) {
      const gpio = gpioOf(s.boardType, pinName);
      if (gpio === null) return null;
      return gpioHasAdc(s.boardType, pinName) ? gpio : null;
    }

    const start = `${partId}:${pinName}`;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const nxt of s.adj?.get(cur) ?? []) {
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        const idx = nxt.indexOf(':');
        if (nxt.slice(0, idx) === s.boardPartId) {
          const boardPinName = nxt.slice(idx + 1);
          const gpio = gpioOf(s.boardType, boardPinName);
          if (gpio === null) return null;
          return gpioHasAdc(s.boardType, boardPinName) ? gpio : null;
        }
        queue.push(nxt);
      }
    }
    return null;
  }

  /** board_pinmaps 查询（catalog 启动导入，01-§6） */
  function gpioOf(boardType: string, pinName: string): number | null {
    const row = db
      .prepare('SELECT gpio_no FROM board_pinmaps WHERE board_type = ? AND pin_name = ?')
      .get(boardType, pinName) as { gpio_no: number } | undefined;
    return row ? row.gpio_no : null;
  }

  /** board_pinmaps capabilities 校验：caps JSON 数组含 'adc' 即 true */
  function gpioHasAdc(boardType: string, pinName: string): boolean {
    const row = db
      .prepare('SELECT capabilities FROM board_pinmaps WHERE board_type = ? AND pin_name = ?')
      .get(boardType, pinName) as { capabilities: string } | undefined;
    if (!row) return false;
    try {
      const caps = JSON.parse(row.capabilities) as string[];
      return Array.isArray(caps) && caps.includes('adc');
    } catch {
      return false;
    }
  }

  // ---- 内部：状态与会话生命周期 ----

  function setState(s: GwSession, state: GwSession['state'], error?: string): void {
    s.state = state;
    send(s, { type: 'state', payload: error ? { status: state, error } : { status: state } });
    if (error) {
      send(s, { type: 'log', payload: { level: 'error', text: error } });
    }
  }

  function detachSerial(s: GwSession): void {
    s.serialSocket?.destroy();
    s.serialSocket = null;
  }

  function detachBridge(s: GwSession): void {
    s.bridge = null;
    s.gpioSocket?.destroy();
    s.gpioSocket = null;
  }

  async function destroySession(s: GwSession, reason: string): Promise<void> {
    if (s.state === 'closed') return;
    clearTimeout(s.graceTimer ?? undefined);
    clearTimeout(s.lifeTimer);
    s.unsubBuild?.();
    s.unsubBuild = null;
    detachSerial(s);
    detachBridge(s);
    if (s.qemuSessionId) {
      await qemu.dispose(s.qemuSessionId, reason);
      s.qemuSessionId = null;
    }
    setState(s, 'closed');
    s.state = 'closed';
    s.socket?.close(1000, 'session closed');
    s.socket = null;
    sessions.delete(s.sid);
    fastify.log.info({ sid: s.sid, reason }, 'ws session destroyed');
  }

  function send(s: GwSession, msg: ServerMsg): void {
    // ws readyState === WebSocket.OPEN（值引用会触发 consistent-type-imports 误报，取常量）
    if (s.socket?.readyState === 1) {
      s.socket.send(JSON.stringify(msg));
    }
  }

  function sendErr(s: GwSession, code: string, message: string): void {
    send(s, { type: 'error.ack', payload: { code, message } });
  }
}

/** 引脚邻接表（PinRef 双向边）；attach 时构建，M5 input.pin BFS 用 */
function buildAdjacency(circuit: CircuitDoc): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const la = adj.get(a);
    if (la) la.push(b);
    else adj.set(a, [b]);
    const lb = adj.get(b);
    if (lb) lb.push(a);
    else adj.set(b, [a]);
  };
  for (const c of circuit.connections) {
    link(c.source, c.target);
  }
  return adj;
}
