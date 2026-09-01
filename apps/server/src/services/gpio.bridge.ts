import type net from 'node:net';

/**
 * QemuGpioBridge（03-§7.2 M7 GPIO/LEDC/ADC 桥·HAL 方案）
 *
 * 连接 QEMU 第二 serial（UART1 桥通道）的字节流 ⇄ 定长帧：
 *   A5 | type | pin | vH | vL | xor(前5字节异或)  —— 6 字节定长
 *   0x01 GPIO_WRITE 固件→宿主（vH=0, vL=0/1，数字写 level）
 *   0x02 PIN_MODE   固件→宿主（vH=0, vL=Arduino mode，pullup/pulldown 位供 release 语义）
 *   0x03 PWM_WRITE  固件→宿主（vH:vL = duty 0–1023，LEDC 10 位归一化）
 *   0x04 PWM_FREQ   固件→宿主（vH:vL = freq Hz，0–65535）
 *   0x11 GPIO_INPUT 宿主→固件（vH=0, vL=0/1，glue 侧注入 + 触发中断）
 *   0x12 ADC_INPUT  宿主→固件（vH:vL = 0–4095，钳位 12 位，analogRead 注入）
 *
 * 坏帧（magic/校验不符）静默丢弃并重同步；分包/粘包由状态机处理。
 * 帧协议与 tools/bridge-glue/esp32sim_bridge.c 保持一致（文档同步见 03-§7.2）。
 */

export const BRIDGE_MAGIC = 0xa5;
export const BRIDGE_FRAME_SIZE = 6;

export const GPIO_WRITE = 0x01;
export const PIN_MODE = 0x02;
export const PWM_WRITE = 0x03;
export const PWM_FREQ = 0x04;
export const GPIO_INPUT = 0x11;
export const ADC_INPUT = 0x12;

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

/** @deprecated 保留兼容旧调用（GPIO_INPUT / injectInput）：等价 encodeFrame16(type, pin, value) */
export function encodeFrame(type: number, pin: number, value: number): Buffer {
  return encodeFrame16(type, pin, value);
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
}

export class QemuGpioBridge {
  private readonly socket: net.Socket;
  private readonly cb: GpioBridgeCallbacks;
  /** 帧装配状态：-1 等待 magic；0..4 payload 下标（[type,pin,vH,vL,chk] = FR_SIZE-1 项） */
  private phase = -1;
  private payload: [number, number, number, number, number] = [0, 0, 0, 0, 0];
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
      if (this.phase === -1) {
        if (b === BRIDGE_MAGIC) this.phase = 0;
        continue;
      }
      this.payload[this.phase] = b;
      this.phase += 1;
      if (this.phase < BRIDGE_FRAME_SIZE - 1) continue;

      this.phase = -1;
      const [type, pin, vH, vL, chk] = this.payload;
      if (((BRIDGE_MAGIC ^ type ^ pin ^ vH ^ vL) & 0xff) !== chk) continue;
      const value16 = ((vH & 0xff) << 8) | (vL & 0xff);
      switch (type) {
        case GPIO_WRITE:
          this.cb.onGpioWrite(pin, vL ? 1 : 0);
          break;
        case PIN_MODE:
          this.cb.onPinMode(pin, vL);
          break;
        case PWM_WRITE:
          this.cb.onPwmWrite(pin, value16 & 0x3ff); /* 10 位域 */
          break;
        case PWM_FREQ:
          this.freqOfPin.set(pin, value16);
          this.cb.onPwmFreq(pin, value16);
          break;
      }
    }
  }
}

/** Arduino mode → pull 语义（release 回退电平用，05-§1.4）：1=pullup 0=pulldown null=无 */
export function pullOfMode(mode: number): 0 | 1 | null {
  if (mode & MODE_PULLUP) return 1;
  if (mode & MODE_PULLDOWN) return 0;
  return null;
}
