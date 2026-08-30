import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import {
  BRIDGE_MAGIC,
  GPIO_INPUT,
  GPIO_WRITE,
  PIN_MODE,
  QemuGpioBridge,
  encodeFrame,
  pullOfMode,
} from './gpio.bridge';

/**
 * L1（02-§4 M5 测试项）：GPIO 桥帧编解码与字节流状态机
 * 帧协议与 tools/bridge-glue/esp32sim_bridge.c 一致（03-§7.2）。
 */

/** 模拟 QEMU 第二 serial socket：记录写出帧 */
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  destroyed = false;

  write(data: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

function framesOf(sock: FakeSocket): Array<[number, number, number]> {
  return sock.written.flatMap((b) => {
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i + 4 < b.length; i += 5) {
      out.push([b[i + 1] as number, b[i + 2] as number, b[i + 3] as number]);
    }
    return out;
  });
}

describe('GPIO 桥帧编解码（03-§7.2 定长帧 + XOR 校验）', () => {
  it('encodeFrame：magic + type + pin + value + xor，与 glue 侧一致', () => {
    const f = encodeFrame(GPIO_WRITE, 4, 1);
    expect([...f]).toEqual([BRIDGE_MAGIC, 0x01, 4, 1, BRIDGE_MAGIC ^ 0x01 ^ 4 ^ 1]);
    expect(f).toHaveLength(5);
  });

  it('pullOfMode：esp32 core 3.x 模式位（PULLUP=0x04/PULLDOWN=0x08）', () => {
    expect(pullOfMode(0x05)).toBe(1); // INPUT_PULLUP
    expect(pullOfMode(0x09)).toBe(0); // INPUT_PULLDOWN
    expect(pullOfMode(0x01)).toBeNull(); // INPUT
    expect(pullOfMode(0x03)).toBeNull(); // OUTPUT
  });
});

describe('QemuGpioBridge 字节流状态机', () => {
  function makeBridge() {
    const fake = new FakeSocket();
    const writes: Array<{ pin: number; level: 0 | 1 }> = [];
    const modes: Array<{ pin: number; mode: number }> = [];
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: (pin, level) => writes.push({ pin, level }),
      onPinMode: (pin, mode) => modes.push({ pin, mode }),
    });
    return { sock: fake, writes, modes, bridge };
  }

  it('单帧整包：GPIO_WRITE 回调（level 归一为 0/1）', () => {
    const { writes, bridge } = makeBridge();
    bridge.feed(encodeFrame(GPIO_WRITE, 4, 1));
    bridge.feed(encodeFrame(GPIO_WRITE, 2, 3)); // 非法 level 归一为 1
    expect(writes).toEqual([
      { pin: 4, level: 1 },
      { pin: 2, level: 1 },
    ]);
  });

  it('粘包：多帧一次喂入全解析', () => {
    const { writes, bridge } = makeBridge();
    const buf = Buffer.concat([
      encodeFrame(GPIO_WRITE, 4, 1),
      encodeFrame(GPIO_WRITE, 4, 0),
      encodeFrame(PIN_MODE, 4, 0x05),
    ]);
    bridge.feed(buf);
    expect(writes).toEqual([
      { pin: 4, level: 1 },
      { pin: 4, level: 0 },
    ]);
  });

  it('分包：一帧拆多次喂入', () => {
    const { writes, bridge } = makeBridge();
    const f = encodeFrame(GPIO_WRITE, 23, 1);
    bridge.feed(f.subarray(0, 2));
    expect(writes).toEqual([]);
    bridge.feed(f.subarray(2, 4));
    expect(writes).toEqual([]);
    bridge.feed(f.subarray(4));
    expect(writes).toEqual([{ pin: 23, level: 1 }]);
  });

  it('坏帧：校验失败丢弃并重同步（噪声字节不污染后续帧）', () => {
    const { writes, bridge } = makeBridge();
    const noise = Buffer.from([0x00, BRIDGE_MAGIC, 0x01, 4, 1, 0xaa, 0x55]); // xor 错
    const good = encodeFrame(GPIO_WRITE, 4, 0);
    bridge.feed(Buffer.concat([noise, good]));
    expect(writes).toEqual([{ pin: 4, level: 0 }]);
  });

  it('PIN_MODE 回调（原值 mode）', () => {
    const { modes, bridge } = makeBridge();
    bridge.feed(encodeFrame(PIN_MODE, 4, 0x05));
    expect(modes).toEqual([{ pin: 4, mode: 0x05 }]);
  });

  it('injectInput：宿主→固件 GPIO_INPUT 帧写出；socket 已销毁则丢弃', () => {
    const { sock, bridge } = makeBridge();
    bridge.injectInput(4, 0);
    expect(framesOf(sock)).toEqual([[GPIO_INPUT, 4, 0]]);
    sock.destroyed = true;
    bridge.injectInput(4, 1);
    expect(framesOf(sock)).toEqual([[GPIO_INPUT, 4, 0]]);
  });
});
