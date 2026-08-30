import { getAudioCtx } from './ctx';

/**
 * 有源蜂鸣器发声（05-§1.8）：电平 1 → 起振（固定音调，M5 开关音；M7 按 pwm.duty 变调）。
 * muted 或 AudioContext suspended 时直接跳过 OscillatorNode.start（视觉照常）。
 * 单实例：同一时刻至多一个蜂鸣器发声（多蜂鸣器后到者接管）。
 */

let osc: OscillatorNode | null = null;
let gain: GainNode | null = null;

/** 有源蜂鸣器典型谐振频率（Hz） */
const TONE_HZ = 2300;

export function startBuzzer(volume0to100: number, muted: boolean): void {
  const ac = getAudioCtx();
  if (!ac || muted) return;
  if (ac.state === 'suspended') return; // 手势解锁失败：保持静音（视觉由组件层负责）
  stopBuzzer();

  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = 'square';
  o.frequency.value = TONE_HZ;
  // 音量 attr 0–100 → 增益 0–0.08（square 谐波丰富，压制到舒适音量）
  g.gain.value = (Math.min(100, Math.max(0, volume0to100)) / 100) * 0.08;
  o.connect(g).connect(ac.destination);
  o.start();
  osc = o;
  gain = g;
}

export function stopBuzzer(): void {
  try {
    osc?.stop();
    osc?.disconnect();
    gain?.disconnect();
  } catch {
    // 已停止
  }
  osc = null;
  gain = null;
}
