import type net from 'node:net';

/**
 * QemuGpioBridge（03-§7.2 M5 GPIO 桥·HAL 方案）
 *
 * 连接 QEMU 第二 serial（UART1 桥通道）的字节流 ⇄ 定长帧：
 *   0xA5 | type | pin | value | xor(前4字节异或)
 *   0x01 GPIO_WRITE 固件→宿主（value=level）
 *   0x02 PIN_MODE   固件→宿主（value=Arduino mode，pullup/pulldown 位供 release 语义）
 *   0x11 GPIO_INPUT 宿主→固件（value=level，glue 侧注入 + 触发中断）
 *
 * 坏帧（magic/校验不符）静默丢弃并重同步；分包/粘包由状态机处理。
 * 帧协议与 tools/bridge-glue/esp32sim_bridge.c 保持一致（文档同步见 03-§7.2）。
 */

export const BRIDGE_MAGIC = 0xa5;
export const BRIDGE_FRAME_SIZE = 5;

export const GPIO_WRITE = 0x01;
export const PIN_MODE = 0x02;
export const GPIO_INPUT = 0x11;

/** Arduino pinMode 模式位（esp32 core 3.x esp32-hal-gpio.h） */
export const MODE_INPUT = 0x01;
export const MODE_OUTPUT = 0x03;
export const MODE_PULLUP = 0x04;
export const MODE_PULLDOWN = 0x08;

export function encodeFrame(type: number, pin: number, value: number): Buffer {
  const head = BRIDGE_MAGIC ^ type ^ pin ^ value;
  return Buffer.from([BRIDGE_MAGIC, type, pin, value, head & 0xff]);
}

export interface GpioBridgeCallbacks {
  /** 固件写 GPIO（0x01） */
  onGpioWrite: (pin: number, level: 0 | 1) => void;
  /** 固件 pinMode（0x02；value=Arduino mode 原值） */
  onPinMode: (pin: number, mode: number) => void;
}

export class QemuGpioBridge {
  private readonly socket: net.Socket;
  private readonly cb: GpioBridgeCallbacks;
  /** 帧装配状态：-1 等待 magic；0..3 payload 下标 */
  private phase = -1;
  private payload: [number, number, number, number] = [0, 0, 0, 0];

  constructor(socket: net.Socket, cb: GpioBridgeCallbacks) {
    this.socket = socket;
    this.cb = cb;
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
  }

  /** 宿主→固件：注入输入电平（glue 侧更新注入表并按沿触发中断） */
  injectInput(pin: number, level: 0 | 1): void {
    this.send(GPIO_INPUT, pin, level);
  }

  send(type: number, pin: number, value: number): void {
    if (!this.socket.destroyed) {
      this.socket.write(encodeFrame(type, pin, value));
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
      const [type, pin, value, chk] = this.payload;
      if (((BRIDGE_MAGIC ^ type ^ pin ^ value) & 0xff) !== chk) continue;
      if (type === GPIO_WRITE) this.cb.onGpioWrite(pin, value ? 1 : 0);
      else if (type === PIN_MODE) this.cb.onPinMode(pin, value);
    }
  }
}

/** Arduino mode → pull 语义（release 回退电平用，05-§1.4）：1=pullup 0=pulldown null=无 */
export function pullOfMode(mode: number): 0 | 1 | null {
  if (mode & MODE_PULLUP) return 1;
  if (mode & MODE_PULLDOWN) return 0;
  return null;
}
