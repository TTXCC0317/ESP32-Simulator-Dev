import type net from 'node:net';

/**
 * QemuGpioBridge（03-§7.2 M7 GPIO/LEDC/ADC + M8 I2C/SPI 桥·HAL 方案）
 *
 * 连接 QEMU 第二 serial（UART1 桥通道）的字节流 ⇄ 双模帧：
 *
 * 定长帧（type ≤ 0x12，M5–M7）：A5 | type | pin | vH | vL | xor(前5字节异或) —— 6 字节
 *   0x01 GPIO_WRITE 固件→宿主（vH=0, vL=0/1，数字写 level）
 *   0x02 PIN_MODE   固件→宿主（vH=0, vL=Arduino mode，pullup/pulldown 位供 release 语义）
 *   0x03 PWM_WRITE  固件→宿主（vH:vL = duty 0–1023，LEDC 10 位归一化）
 *   0x04 PWM_FREQ   固件→宿主（vH:vL = freq Hz，0–65535）
 *   0x11 GPIO_INPUT 宿主→固件（vH=0, vL=0/1，glue 侧注入 + 触发中断）
 *   0x12 ADC_INPUT  宿主→固件（vH:vL = 0–4095，钳位 12 位，analogRead 注入）
 *
 * TLV 变长帧（type ≥ 0x20，M8 I2C/SPI 事务）：A5 | type | len | [payload×len] | xor(前 len+3 字节异或)
 *   0x20 I2C_TXN    固件→宿主（payload: addr | dir | len | data[]）
 *   0x21 SPI_TXN    固件→宿主（payload: cs | len | data[]）
 *   0x30 SENSOR_REPLY 宿主→固件（payload: addr | len | data[]，I2C 读应答）
 *   0x31 SPI_REPLY    宿主→固件（payload: cs | len | data[]，SPI 应答）
 *
 * 状态机按 type 首字节分支：type < TLV_THRESHOLD 走定长解析，≥ TLV_THRESHOLD 走变长解析。
 * 坏帧（magic/校验不符）静默丢弃并重同步；分包/粘包由状态机处理。
 * 帧协议与 tools/bridge-glue/esp32sim_bridge.c + bus_shim.cpp 保持一致（文档同步见 03-§7.2.2）。
 */

export const BRIDGE_MAGIC = 0xa5;
export const BRIDGE_FRAME_SIZE = 6;
/** type ≥ 此阈值走 TLV 变长帧解析；< 此阈值走 6 字节定长帧解析 */
export const TLV_THRESHOLD = 0x20;

export const GPIO_WRITE = 0x01;
export const PIN_MODE = 0x02;
export const PWM_WRITE = 0x03;
export const PWM_FREQ = 0x04;
export const GPIO_INPUT = 0x11;
export const ADC_INPUT = 0x12;

/** M8 TLV 帧类型 */
export const I2C_TXN = 0x20;
export const SPI_TXN = 0x21;
/** M8 后续：DHT22 单总线请求（payload: pin 1 byte） */
export const DHT22_TXN = 0x22;
export const SENSOR_REPLY = 0x30;
export const SPI_REPLY = 0x31;
/** M8 后续：DHT22 回复（payload: pin | tempRaw_hi | tempRaw_lo | humRaw_hi | humRaw_lo） */
export const DHT22_REPLY = 0x32;

/** Arduino pinMode 模式位（esp32 core 3.x esp32-hal-gpio.h） */
export const MODE_INPUT = 0x01;
export const MODE_OUTPUT = 0x03;
export const MODE_PULLUP = 0x04;
export const MODE_PULLDOWN = 0x08;

/** 6 字节帧编码（vH:vL 拆分 value16）——与 glue 侧 br_send_frame 逐字节同构 */
export function encodeFrame16(type: number, pin: number, value16: number): Buffer {
  const vH = (value16 >> 8) & 0xff;
  const vL = value16 & 0xff;
  const xor = BRIDGE_MAGIC ^ type ^ pin ^ vH ^ vL;
  return Buffer.from([BRIDGE_MAGIC, type, pin, vH, vL, xor & 0xff]);
}

/** TLV 变长帧编码（M8）——A5 | type | len | payload | xor(前 len+3 字节) */
export function encodeTlvFrame(type: number, payload: Uint8Array): Buffer {
  const len = payload.length & 0xff;
  const buf = Buffer.allocUnsafe(3 + len + 1); // magic + type + len + payload + xor
  buf[0] = BRIDGE_MAGIC;
  buf[1] = type & 0xff;
  buf[2] = len;
  buf.set(payload, 3); // 复制 payload 字节
  let xor = BRIDGE_MAGIC ^ (type & 0xff) ^ len;
  for (const b of payload) xor ^= b;
  buf[3 + len] = xor & 0xff;
  return buf;
}

/** @deprecated 保留兼容旧调用（GPIO_INPUT / injectInput）：等价 encodeFrame16(type, pin, value) */
export function encodeFrame(type: number, pin: number, value: number): Buffer {
  return encodeFrame16(type, pin, value);
}

export interface I2cTxnEvent {
  addr: number;
  dir: 'r' | 'w';
  data: Uint8Array;
}

export interface SpiTxnEvent {
  cs: number;
  data: Uint8Array;
}

/** M8 后续：DHT22 单总线请求事件（DHT22_TXN 帧，payload: pin） */
export interface DhtTxnEvent {
  pin: number;
}

export interface GpioBridgeCallbacks {
  /** 固件写 GPIO（0x01） */
  onGpioWrite: (pin: number, level: 0 | 1) => void;
  /** 固件 pinMode（0x02；value=Arduino mode 原值） */
  onPinMode: (pin: number, mode: number) => void;
  /** 固件 PWM duty（0x03；duty=0–1023 10 位） */
  onPwmWrite: (pin: number, duty: number) => void;
  /** 固件 PWM 频率（0x04；freq=Hz） */
  onPwmFreq: (pin: number, freq: number) => void;
  /** M8 固件 I2C 事务（0x20；可选，未注册则丢弃） */
  onI2cTxn?: (ev: I2cTxnEvent) => void;
  /** M8 固件 SPI 事务（0x21；可选，未注册则丢弃） */
  onSpiTxn?: (ev: SpiTxnEvent) => void;
  /** M8 后续：固件 DHT22 请求（0x22；可选，未注册则丢弃） */
  onDhtTxn?: (ev: DhtTxnEvent) => void;
}

/** 帧装配阶段 */
const PHASE_MAGIC = -1;
const PHASE_TYPE = 0;
const PHASE_FIXED = 1; // 定长帧：收集 [pin, vH, vL, chk] = 4 字节
const PHASE_TLV_LEN = 2; // TLV 帧：读 len 字节
const PHASE_TLV_PAYLOAD = 3; // TLV 帧：收集 payload + chk = len+1 字节

export class QemuGpioBridge {
  private readonly socket: net.Socket;
  private readonly cb: GpioBridgeCallbacks;
  /** 帧装配状态 */
  private phase: number = PHASE_MAGIC;
  /** 定长帧：[type, pin, vH, vL, chk]，type 在 PHASE_TYPE 填 [0]，其余 4 字节在 PHASE_FIXED 填 */
  private fixedBuf: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  private fixedIdx = 1; // fixedBuf 的下一个写入下标（1..4）
  /** TLV 帧：当前 type + len + 收集缓冲 */
  private tlvType = 0;
  private tlvLen = 0;
  private tlvBuf: number[] = [];
  private tlvIdx = 0; // tlvBuf 已写入字节数（0..tlvLen）
  /** PWM freq 跟踪（默认 1000）——WS pwm.duty 上报组合 freq 用 */
  private readonly freqOfPin: Map<number, number> = new Map();

  constructor(socket: net.Socket, cb: GpioBridgeCallbacks) {
    this.socket = socket;
    this.cb = cb;
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
  }

  /** 宿主→固件：注入输入电平（glue 侧更新注入表并按沿触发中断） */
  injectInput(pin: number, level: 0 | 1): void {
    this.send(GPIO_INPUT, pin, level);
  }

  /** 宿主→固件：注入模拟值（0–4095 钳位，glue 侧 analogRead 返回注入值） */
  injectAnalog(pin: number, value: number): void {
    const value16 = Math.max(0, Math.min(4095, Math.trunc(value)));
    this.send16(ADC_INPUT, pin, value16);
  }

  /** M8 宿主→固件：I2C 读应答（SENSOR_REPLY 帧） */
  sendI2cReply(addr: number, data: Uint8Array): void {
    if (this.socket.destroyed) return;
    const payload = Buffer.alloc(1 + data.length);
    payload[0] = addr & 0x7f;
    payload.set(data, 1);
    this.socket.write(encodeTlvFrame(SENSOR_REPLY, payload));
  }

  /** M8 宿主→固件：SPI 应答（SPI_REPLY 帧） */
  sendSpiReply(cs: number, data: Uint8Array): void {
    if (this.socket.destroyed) return;
    const payload = Buffer.alloc(1 + data.length);
    payload[0] = cs & 0xff;
    payload.set(data, 1);
    this.socket.write(encodeTlvFrame(SPI_REPLY, payload));
  }

  /**
   * M8 后续：宿主→固件：DHT22 应答（DHT22_REPLY 帧）
   * payload: pin(1) | tempRaw_hi(1) | tempRaw_lo(1) | humRaw_hi(1) | humRaw_lo(1)
   * tempRaw/humRaw = Math.round(value * 10) —— DHT22 原始协议 ×10 整数格式
   */
  sendDhtReply(pin: number, tempRaw: number, humRaw: number): void {
    if (this.socket.destroyed) return;
    const payload = Buffer.alloc(5);
    payload[0] = pin & 0xff;
    payload[1] = (tempRaw >> 8) & 0xff;
    payload[2] = tempRaw & 0xff;
    payload[3] = (humRaw >> 8) & 0xff;
    payload[4] = humRaw & 0xff;
    this.socket.write(encodeTlvFrame(DHT22_REPLY, payload));
  }

  /** 获取当前 PWM 频率（默认 1000Hz） */
  getFreq(pin: number): number {
    return this.freqOfPin.get(pin) ?? 1000;
  }

  send(type: number, pin: number, value: number): void {
    this.send16(type, pin, value);
  }

  send16(type: number, pin: number, value16: number): void {
    if (!this.socket.destroyed) {
      this.socket.write(encodeFrame16(type, pin, value16));
    }
  }

  dispose(): void {
    this.socket.destroy();
  }

  /** 字节流喂入（粘包/分包重同步，测试可直接喂） */
  feed(chunk: Buffer): void {
    for (const b of chunk) {
      if (this.phase === PHASE_MAGIC) {
        if (b === BRIDGE_MAGIC) this.phase = PHASE_TYPE;
        continue;
      }
      if (this.phase === PHASE_TYPE) {
        if (b < TLV_THRESHOLD) {
          this.fixedBuf[0] = b;
          this.fixedIdx = 1;
          this.phase = PHASE_FIXED;
        } else {
          this.tlvType = b;
          this.phase = PHASE_TLV_LEN;
        }
        continue;
      }
      if (this.phase === PHASE_FIXED) {
        this.fixedBuf[this.fixedIdx] = b;
        this.fixedIdx += 1;
        if (this.fixedIdx < BRIDGE_FRAME_SIZE - 1) continue; // 还需 [pin,vH,vL,chk] 的剩余字节
        // 5 字节收集完（[type,pin,vH,vL,chk]），校验并派发
        this.phase = PHASE_MAGIC;
        const [type, pin, vH, vL, chk] = this.fixedBuf;
        if (((BRIDGE_MAGIC ^ type ^ pin ^ vH ^ vL) & 0xff) !== chk) continue;
        const value16 = ((vH & 0xff) << 8) | (vL & 0xff);
        this.dispatchFixed(type, pin, value16);
        continue;
      }
      if (this.phase === PHASE_TLV_LEN) {
        this.tlvLen = b;
        this.tlvBuf = new Array(b);
        this.tlvIdx = 0;
        this.phase = PHASE_TLV_PAYLOAD;
        continue;
      }
      if (this.phase === PHASE_TLV_PAYLOAD) {
        this.tlvBuf[this.tlvIdx] = b;
        this.tlvIdx += 1;
        if (this.tlvIdx < this.tlvLen + 1) continue; // payload[len] + chk[1]
        // 收集完 payload + chk
        this.phase = PHASE_MAGIC;
        const chk = this.tlvBuf[this.tlvLen] ?? 0;
        let xor = BRIDGE_MAGIC ^ this.tlvType ^ this.tlvLen;
        for (let i = 0; i < this.tlvLen; i++) xor ^= this.tlvBuf[i] ?? 0;
        if ((xor & 0xff) !== chk) continue;
        this.dispatchTlv(this.tlvType, this.tlvBuf.slice(0, this.tlvLen));
        continue;
      }
    }
  }

  private dispatchFixed(type: number, pin: number, value16: number): void {
    switch (type) {
      case GPIO_WRITE:
        this.cb.onGpioWrite(pin, (value16 & 1) as 0 | 1);
        break;
      case PIN_MODE:
        this.cb.onPinMode(pin, value16 & 0xff);
        break;
      case PWM_WRITE:
        this.cb.onPwmWrite(pin, value16 & 0x3ff);
        break;
      case PWM_FREQ:
        this.freqOfPin.set(pin, value16);
        this.cb.onPwmFreq(pin, value16);
        break;
    }
  }

  private dispatchTlv(type: number, payload: number[]): void {
    if (type === I2C_TXN) {
      // payload: addr(7bit) | dir(1=read/0=write) | len | data[len]
      if (payload.length < 3) return;
      const addr = (payload[0] ?? 0) & 0x7f;
      const dir = (payload[1] ?? 0) ? 'r' : 'w';
      const len = payload[2] ?? 0;
      const data = Uint8Array.from(payload.slice(3, 3 + len));
      this.cb.onI2cTxn?.({ addr, dir, data });
    } else if (type === SPI_TXN) {
      // payload: cs | len | data[len]
      if (payload.length < 2) return;
      const cs = payload[0] ?? 0;
      const len = payload[1] ?? 0;
      const data = Uint8Array.from(payload.slice(2, 2 + len));
      this.cb.onSpiTxn?.({ cs, data });
    } else if (type === DHT22_TXN) {
      // payload: pin (1 byte)
      if (payload.length < 1) return;
      const pin = payload[0] ?? 0;
      this.cb.onDhtTxn?.({ pin });
    }
  }
}

/** Arduino mode → pull 语义（release 回退电平用，05-§1.4）：1=pullup 0=pulldown null=无 */
export function pullOfMode(mode: number): 0 | 1 | null {
  if (mode & MODE_PULLUP) return 1;
  if (mode & MODE_PULLDOWN) return 0;
  return null;
}
