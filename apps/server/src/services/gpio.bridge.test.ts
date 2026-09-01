import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import {
  BRIDGE_MAGIC,
  BRIDGE_FRAME_SIZE,
  GPIO_INPUT,
  ADC_INPUT,
  GPIO_WRITE,
  PIN_MODE,
  PWM_WRITE,
  PWM_FREQ,
  QemuGpioBridge,
  encodeFrame,
  encodeFrame16,
  pullOfMode,
} from './gpio.bridge';

/**
 * L1（02-§4 M5/M7 测试项）：GPIO 桥帧编解码与字节流状态机
 * 帧协议与 tools/bridge-glue/esp32sim_bridge.c 一致（03-§7.2）。
 * M7：6 字节定长帧（A5|type|pin|vH|vL|xor），新增 PWM/ADC 类型。
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

/** 解析已写出的 6 字节帧 → [type, pin, value16] */
function framesOf(sock: FakeSocket): Array<[number, number, number]> {
  return sock.written.flatMap((b) => {
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i + BRIDGE_FRAME_SIZE <= b.length; i += BRIDGE_FRAME_SIZE) {
      const type = b[i + 1] as number;
      const pin = b[i + 2] as number;
      const vH = b[i + 3] as number;
      const vL = b[i + 4] as number;
      out.push([type, pin, ((vH & 0xff) << 8) | (vL & 0xff)]);
    }
    return out;
  });
}

describe('GPIO 桥帧编解码（03-§7.2 6 字节定长帧 + XOR 校验）', () => {
  it('encodeFrame：6 字节 magic + type + pin + vH(0) + vL + xor，与 glue 侧一致', () => {
    const f = encodeFrame(GPIO_WRITE, 4, 1);
    const vH = 0;
    const vL = 1;
    const xor = BRIDGE_MAGIC ^ GPIO_WRITE ^ 4 ^ vH ^ vL;
    expect([...f]).toEqual([BRIDGE_MAGIC, GPIO_WRITE, 4, vH, vL, xor & 0xff]);
    expect(f).toHaveLength(6);
  });

  it('encodeFrame16：vH/vL 拆分 16 位值（PWM duty 1023）', () => {
    const duty = 1023; // 0x03FF
    const f = encodeFrame16(PWM_WRITE, 5, duty);
    const vH = (duty >> 8) & 0xff; // 0x03
    const vL = duty & 0xff; // 0xff
    expect(vH).toBe(0x03);
    expect(vL).toBe(0xff);
    const xor = BRIDGE_MAGIC ^ PWM_WRITE ^ 5 ^ vH ^ vL;
    expect([...f]).toEqual([BRIDGE_MAGIC, PWM_WRITE, 5, vH, vL, xor & 0xff]);
  });

  it('encodeFrame16：ADC 值 4095 钳位编码', () => {
    const f = encodeFrame16(ADC_INPUT, 36, 4095); // 0x0FFF
    expect(f[3]).toBe(0x0f); // vH
    expect(f[4]).toBe(0xff); // vL
  });

  it('pullOfMode：esp32 core 3.x 模式位（PULLUP=0x04/PULLDOWN=0x08）', () => {
    expect(pullOfMode(0x05)).toBe(1); // INPUT_PULLUP
    expect(pullOfMode(0x09)).toBe(0); // INPUT_PULLDOWN
    expect(pullOfMode(0x01)).toBeNull(); // INPUT
    expect(pullOfMode(0x03)).toBeNull(); // OUTPUT
  });
});

describe('QemuGpioBridge 字节流状态机（6 字节帧）', () => {
  function makeBridge() {
    const fake = new FakeSocket();
    const writes: Array<{ pin: number; level: 0 | 1 }> = [];
    const modes: Array<{ pin: number; mode: number }> = [];
    const pwms: Array<{ pin: number; duty: number }> = [];
    const freqs: Array<{ pin: number; freq: number }> = [];
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: (pin, level) => writes.push({ pin, level }),
      onPinMode: (pin, mode) => modes.push({ pin, mode }),
      onPwmWrite: (pin, duty) => pwms.push({ pin, duty }),
      onPwmFreq: (pin, freq) => freqs.push({ pin, freq }),
    });
    return { sock: fake, writes, modes, pwms, freqs, bridge };
  }

  it('单帧整包：GPIO_WRITE 回调（level 归一为 0/1，vH=0 忽略）', () => {
    const { writes, bridge } = makeBridge();
    bridge.feed(encodeFrame16(GPIO_WRITE, 4, 1));
    bridge.feed(encodeFrame16(GPIO_WRITE, 2, 3)); // vL=3 仍归一为 1
    expect(writes).toEqual([
      { pin: 4, level: 1 },
      { pin: 2, level: 1 },
    ]);
  });

  it('PWM_WRITE 6 字节帧解析 → onPwmWrite 回调（10 位域）', () => {
    const { pwms, bridge } = makeBridge();
    // duty = 1020 (0x03FC，对应 analogWrite(255) ×4)
    bridge.feed(encodeFrame16(PWM_WRITE, 4, 1020));
    // duty = 512 (0x0200)
    bridge.feed(encodeFrame16(PWM_WRITE, 5, 512));
    // duty = 0xFFFF → 10 位截断为 0x3FF = 1023
    bridge.feed(encodeFrame16(PWM_WRITE, 6, 0xffff));
    expect(pwms).toEqual([
      { pin: 4, duty: 1020 },
      { pin: 5, duty: 512 },
      { pin: 6, duty: 1023 },
    ]);
  });

  it('PWM_FREQ 帧 → onPwmFreq 回调 + freqOfPin 跟踪', () => {
    const { freqs, bridge } = makeBridge();
    bridge.feed(encodeFrame16(PWM_FREQ, 4, 5000));
    bridge.feed(encodeFrame16(PWM_FREQ, 4, 1000));
    expect(freqs).toEqual([
      { pin: 4, freq: 5000 },
      { pin: 4, freq: 1000 },
    ]);
    expect(bridge.getFreq(4)).toBe(1000);
    expect(bridge.getFreq(99)).toBe(1000); // 默认 1000Hz
  });

  it('粘包：多帧一次喂入全解析（GPIO + PWM + PIN_MODE）', () => {
    const { writes, pwms, modes, bridge } = makeBridge();
    const buf = Buffer.concat([
      encodeFrame16(GPIO_WRITE, 4, 1),
      encodeFrame16(PWM_WRITE, 4, 512),
      encodeFrame16(PIN_MODE, 4, 0x05),
      encodeFrame16(PWM_FREQ, 4, 2000),
    ]);
    bridge.feed(buf);
    expect(writes).toEqual([{ pin: 4, level: 1 }]);
    expect(pwms).toEqual([{ pin: 4, duty: 512 }]);
    expect(modes).toEqual([{ pin: 4, mode: 0x05 }]);
  });

  it('分包：一帧拆多次喂入（6 字节帧）', () => {
    const { pwms, bridge } = makeBridge();
    const f = encodeFrame16(PWM_WRITE, 23, 1023);
    bridge.feed(f.subarray(0, 2));
    expect(pwms).toEqual([]);
    bridge.feed(f.subarray(2, 5));
    expect(pwms).toEqual([]);
    bridge.feed(f.subarray(5));
    expect(pwms).toEqual([{ pin: 23, duty: 1023 }]);
  });

  it('6 字节帧坏 xor 丢弃并重同步（噪声字节不污染后续帧）', () => {
    const { pwms, bridge } = makeBridge();
    // 构造坏帧：第 5 字节 xor 用 0xaa 替换正确值
    const bad = Buffer.from([
      0x00,
      BRIDGE_MAGIC,
      PWM_WRITE,
      4,
      0x03,
      0xff,
      0xaa, // 伪造的坏 xor
      0x55,
    ]);
    const good = encodeFrame16(PWM_WRITE, 4, 1023);
    bridge.feed(Buffer.concat([bad, good]));
    expect(pwms).toEqual([{ pin: 4, duty: 1023 }]);
  });

  it('GPIO_WRITE 旧 vH=0 仍能解析 → 向后兼容', () => {
    const { writes, bridge } = makeBridge();
    // 模拟"旧类型 5 字节思维"编码，但新协议是 6 字节
    const frame = encodeFrame(GPIO_WRITE, 4, 1); // vH=0, vL=1
    expect(frame[3]).toBe(0); // vH 必须为 0
    expect(frame[4]).toBe(1); // vL = value
    bridge.feed(frame);
    expect(writes).toEqual([{ pin: 4, level: 1 }]);
  });

  it('PIN_MODE 回调（原值 mode，vH=0）', () => {
    const { modes, bridge } = makeBridge();
    bridge.feed(encodeFrame16(PIN_MODE, 4, 0x05));
    expect(modes).toEqual([{ pin: 4, mode: 0x05 }]);
  });

  it('injectInput：宿主→固件 GPIO_INPUT 6 字节帧写出；socket 已销毁则丢弃', () => {
    const { sock, bridge } = makeBridge();
    bridge.injectInput(4, 0);
    expect(framesOf(sock)).toEqual([[GPIO_INPUT, 4, 0]]);
    sock.destroyed = true;
    bridge.injectInput(4, 1);
    expect(framesOf(sock)).toEqual([[GPIO_INPUT, 4, 0]]); // 不再追加
  });

  it('injectAnalog → ADC_INPUT 6 字节帧编码（值钳位 0–4095）', () => {
    const { sock, bridge } = makeBridge();
    bridge.injectAnalog(36, 2048); // 中间值
    bridge.injectAnalog(39, 4095); // 最大值
    bridge.injectAnalog(34, -100); // 负数 → 钳位为 0
    bridge.injectAnalog(35, 9999); // 超限 → 钳位为 4095
    bridge.injectAnalog(33, 1.7); // 小数 → trunc → 1
    const frames = framesOf(sock);
    expect(frames).toEqual([
      [ADC_INPUT, 36, 2048],
      [ADC_INPUT, 39, 4095],
      [ADC_INPUT, 34, 0],
      [ADC_INPUT, 35, 4095],
      [ADC_INPUT, 33, 1],
    ]);
  });
});
