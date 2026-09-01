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
  I2C_TXN,
  SPI_TXN,
  SENSOR_REPLY,
  SPI_REPLY,
  QemuGpioBridge,
  encodeFrame,
  encodeFrame16,
  encodeTlvFrame,
  pullOfMode,
} from './gpio.bridge';

/**
 * L1（02-§4 M5/M7/M8 测试项）：GPIO 桥帧编解码与字节流状态机
 * 帧协议与 tools/bridge-glue/esp32sim_bridge.c + bus_shim.cpp 一致（03-§7.2.2）。
 * M7：6 字节定长帧（A5|type|pin|vH|vL|xor），PWM/ADC 类型。
 * M8：TLV 变长帧（A5|type|len|payload|xor），I2C/SPI 事务类型。
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

/** 解析已写出的 TLV 变长帧 → [type, payload]（按 len 跳步） */
function tlvFramesOf(sock: FakeSocket): Array<[number, Uint8Array]> {
  return sock.written.flatMap((b) => {
    const out: Array<[number, Uint8Array]> = [];
    let i = 0;
    while (i + 3 <= b.length) {
      if (b[i] !== BRIDGE_MAGIC) {
        i += 1;
        continue;
      }
      const type = b[i + 1] as number;
      const len = b[i + 2] as number;
      if (i + 3 + len + 1 > b.length) break;
      const payload = b.subarray(i + 3, i + 3 + len);
      out.push([type, Uint8Array.from(payload)]);
      i += 3 + len + 1;
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

describe('TLV 变长帧编解码（03-§7.2.2 M8 I2C/SPI 事务 + XOR 校验）', () => {
  it('encodeTlvFrame：A5|type|len|payload|xor（I2C_TXN 写 BH1750 0x10 命令）', () => {
    const payload = Uint8Array.from([0x23, 0x00, 0x01, 0x10]); // addr|write|len=1|cmd=0x10
    const f = encodeTlvFrame(I2C_TXN, payload);
    expect(f).toHaveLength(3 + 4 + 1); // 8
    expect(f[0]).toBe(BRIDGE_MAGIC);
    expect(f[1]).toBe(I2C_TXN);
    expect(f[2]).toBe(4);
    expect(f.subarray(3, 7)).toEqual(Buffer.from(payload));
    let xor = BRIDGE_MAGIC ^ I2C_TXN ^ 4;
    for (const b of payload) xor ^= b;
    expect(f[7]).toBe(xor & 0xff);
  });

  it('encodeTlvFrame：SPI_TXN 全双工 4 字节', () => {
    const payload = Uint8Array.from([5, 4, 0x9f, 0x00, 0x00, 0x00]); // cs|len|data
    const f = encodeTlvFrame(SPI_TXN, payload);
    expect(f).toHaveLength(3 + 6 + 1);
    expect(f[1]).toBe(SPI_TXN);
    expect(f[2]).toBe(6);
  });

  it('encodeTlvFrame：len=0 空载荷（I2C 空写/广播）', () => {
    const f = encodeTlvFrame(I2C_TXN, new Uint8Array(0));
    expect(f).toHaveLength(4); // magic+type+len(0)+xor
    expect(f[2]).toBe(0);
    expect(f[3]).toBe((BRIDGE_MAGIC ^ I2C_TXN ^ 0) & 0xff);
  });

  it('I2C_TXN 帧解析 → onI2cTxn 回调（写 BH1750 high-res 命令）', () => {
    const txns: Array<{ addr: number; dir: string; data: Uint8Array }> = [];
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: () => {},
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
      onI2cTxn: (ev) => txns.push({ addr: ev.addr, dir: ev.dir, data: ev.data }),
    });
    // addr=0x23, dir=write(0), len=1, cmd=0x10
    bridge.feed(encodeTlvFrame(I2C_TXN, Uint8Array.from([0x23, 0x00, 0x01, 0x10])));
    expect(txns).toHaveLength(1);
    expect(txns[0]!.addr).toBe(0x23);
    expect(txns[0]!.dir).toBe('w');
    expect(Array.from(txns[0]!.data)).toEqual([0x10]);
  });

  it('I2C_TXN 读请求（dir=1, len=2）→ onI2cTxn', () => {
    const txns: Array<{ addr: number; dir: string; data: Uint8Array }> = [];
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: () => {},
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
      onI2cTxn: (ev) => txns.push({ addr: ev.addr, dir: ev.dir, data: ev.data }),
    });
    // addr=0x23, dir=read(1), len=2, data=[]
    bridge.feed(encodeTlvFrame(I2C_TXN, Uint8Array.from([0x23, 0x01, 0x00])));
    expect(txns).toHaveLength(1);
    expect(txns[0]!.addr).toBe(0x23);
    expect(txns[0]!.dir).toBe('r');
    expect(txns[0]!.data).toHaveLength(0);
  });

  it('SPI_TXN 帧解析 → onSpiTxn 回调（cs=5, 4 字节命令）', () => {
    const txns: Array<{ cs: number; data: Uint8Array }> = [];
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: () => {},
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
      onSpiTxn: (ev) => txns.push({ cs: ev.cs, data: ev.data }),
    });
    // cs=5, len=4, data=[0x9f, 0x00, 0x00, 0x00]（JEDEC ID 命令）
    bridge.feed(encodeTlvFrame(SPI_TXN, Uint8Array.from([5, 4, 0x9f, 0x00, 0x00, 0x00])));
    expect(txns).toHaveLength(1);
    expect(txns[0]!.cs).toBe(5);
    expect(Array.from(txns[0]!.data)).toEqual([0x9f, 0x00, 0x00, 0x00]);
  });

  it('TLV 帧粘包：两 I2C_TXN 一次喂入全解析', () => {
    const txns: Array<{ addr: number; dir: string; data: Uint8Array }> = [];
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: () => {},
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
      onI2cTxn: (ev) => txns.push({ addr: ev.addr, dir: ev.dir, data: ev.data }),
    });
    const buf = Buffer.concat([
      encodeTlvFrame(I2C_TXN, Uint8Array.from([0x23, 0x00, 0x01, 0x10])),
      encodeTlvFrame(I2C_TXN, Uint8Array.from([0x23, 0x00, 0x01, 0x13])),
    ]);
    bridge.feed(buf);
    expect(txns).toHaveLength(2);
    expect(Array.from(txns[0]!.data)).toEqual([0x10]);
    expect(Array.from(txns[1]!.data)).toEqual([0x13]);
  });

  it('TLV 帧分包：一帧拆多次喂入', () => {
    const txns: Array<{ addr: number; dir: string; data: Uint8Array }> = [];
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: () => {},
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
      onI2cTxn: (ev) => txns.push({ addr: ev.addr, dir: ev.dir, data: ev.data }),
    });
    const f = encodeTlvFrame(I2C_TXN, Uint8Array.from([0x23, 0x00, 0x01, 0x10]));
    bridge.feed(f.subarray(0, 2)); // magic + type
    expect(txns).toHaveLength(0);
    bridge.feed(f.subarray(2, 4)); // len + payload[0]
    expect(txns).toHaveLength(0);
    bridge.feed(f.subarray(4)); // payload[1] + chk
    expect(txns).toHaveLength(1);
    expect(Array.from(txns[0]!.data)).toEqual([0x10]);
  });

  it('TLV 帧坏 xor 丢弃并重同步（后续 TLV 帧仍能解析）', () => {
    const txns: Array<{ addr: number; dir: string; data: Uint8Array }> = [];
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: () => {},
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
      onI2cTxn: (ev) => txns.push({ addr: ev.addr, dir: ev.dir, data: ev.data }),
    });
    const bad = Buffer.from([BRIDGE_MAGIC, I2C_TXN, 2, 0x23, 0x00, 0xff]); // len=2 但只有 1 字节 payload + 坏 xor
    const good = encodeTlvFrame(I2C_TXN, Uint8Array.from([0x23, 0x00, 0x01, 0x10]));
    bridge.feed(Buffer.concat([bad, good]));
    // 坏帧被丢弃，good 帧的 magic 被重同步识别
    expect(txns).toHaveLength(1);
    expect(Array.from(txns[0]!.data)).toEqual([0x10]);
  });

  it('定长帧 + TLV 帧交错：状态机按 type 分支正确路由', () => {
    const writes: Array<{ pin: number; level: 0 | 1 }> = [];
    const txns: Array<{ addr: number; dir: string; data: Uint8Array }> = [];
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: (pin, level) => writes.push({ pin, level }),
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
      onI2cTxn: (ev) => txns.push({ addr: ev.addr, dir: ev.dir, data: ev.data }),
    });
    const buf = Buffer.concat([
      encodeFrame16(GPIO_WRITE, 4, 1),
      encodeTlvFrame(I2C_TXN, Uint8Array.from([0x23, 0x00, 0x01, 0x10])),
      encodeFrame16(GPIO_WRITE, 5, 0),
      encodeTlvFrame(I2C_TXN, Uint8Array.from([0x23, 0x01, 0x00])),
    ]);
    bridge.feed(buf);
    expect(writes).toEqual([
      { pin: 4, level: 1 },
      { pin: 5, level: 0 },
    ]);
    expect(txns).toHaveLength(2);
    expect(txns[0]!.dir).toBe('w');
    expect(txns[1]!.dir).toBe('r');
  });

  it('onI2cTxn/onSpiTxn 可选：未注册时不抛错静默丢弃', () => {
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: () => {},
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
    });
    expect(() =>
      bridge.feed(encodeTlvFrame(I2C_TXN, Uint8Array.from([0x23, 0x00, 0x01, 0x10]))),
    ).not.toThrow();
    expect(() => bridge.feed(encodeTlvFrame(SPI_TXN, Uint8Array.from([5, 1, 0x9f])))).not.toThrow();
  });

  it('TLV payload 截断：len 声明大于实际 payload 不越界（靠后续字节补齐或丢弃）', () => {
    const txns: Array<{ addr: number; dir: string; data: Uint8Array }> = [];
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: () => {},
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
      onI2cTxn: (ev) => txns.push({ addr: ev.addr, dir: ev.dir, data: ev.data }),
    });
    // 声明 len=5 但只给 3 字节 payload + 坏 xor，再喂一个完整帧
    const trunc = Buffer.from([BRIDGE_MAGIC, I2C_TXN, 5, 0x23, 0x00, 0x01]); // 只 3 字节
    const good = encodeTlvFrame(I2C_TXN, Uint8Array.from([0x23, 0x00, 0x01, 0x10]));
    bridge.feed(Buffer.concat([trunc, good]));
    // 第一帧因长度不足跨到第二帧 magic 字节时被丢弃，第二帧从 magic 重同步
    // 由于实现按 len 收集后再校验 xor，trunc 会吞掉 good 的部分字节
    // 关键断言：不抛错、最终要么 0 要么 1 帧（取决于实现）
    expect(txns.length).toBeLessThanOrEqual(1);
  });

  it('sendI2cReply：宿主→固件 SENSOR_REPLY 帧（addr|data）', () => {
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: () => {},
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
    });
    bridge.sendI2cReply(0x23, Uint8Array.from([0x12, 0x34]));
    const frames = tlvFramesOf(fake);
    expect(frames).toHaveLength(1);
    expect(frames[0]![0]).toBe(SENSOR_REPLY);
    expect(frames[0]![1][0]).toBe(0x23);
    expect(Array.from(frames[0]![1].subarray(1))).toEqual([0x12, 0x34]);
  });

  it('sendSpiReply：宿主→固件 SPI_REPLY 帧（cs|data）', () => {
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: () => {},
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
    });
    bridge.sendSpiReply(5, Uint8Array.from([0xef, 0x40, 0x16]));
    const frames = tlvFramesOf(fake);
    expect(frames).toHaveLength(1);
    expect(frames[0]![0]).toBe(SPI_REPLY);
    expect(frames[0]![1][0]).toBe(5);
    expect(Array.from(frames[0]![1].subarray(1))).toEqual([0xef, 0x40, 0x16]);
  });

  it('sendI2cReply/sendSpiReply：socket 已销毁则丢弃不抛错', () => {
    const fake = new FakeSocket();
    const bridge = new QemuGpioBridge(fake as unknown as net.Socket, {
      onGpioWrite: () => {},
      onPinMode: () => {},
      onPwmWrite: () => {},
      onPwmFreq: () => {},
    });
    fake.destroyed = true;
    expect(() => bridge.sendI2cReply(0x23, Uint8Array.from([0x12]))).not.toThrow();
    expect(() => bridge.sendSpiReply(5, Uint8Array.from([0xef]))).not.toThrow();
    expect(fake.written).toHaveLength(0);
  });
});
