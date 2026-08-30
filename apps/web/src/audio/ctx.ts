/**
 * AudioContext 单例（05-§1.8 E4）：蜂鸣器与 M7 后续发声元件共用。
 * - lazy 创建（首次 startBuzzer/unlockAudio）；创建失败返回 null（无声音环境降级）；
 * - unlockAudio()：首次 ▶ 运行时调用 resume（浏览器自动播放策略要求用户手势）；
 * - 蜂鸣器 start 前检查 state，suspended 时跳过（视觉照常，Inspector 提示由组件层处理）。
 */

let ctx: AudioContext | null = null;

export function getAudioCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor = window.AudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

/** 用户手势时机调用（TopBar ▶ 运行）；已有实例时 resume，忽略失败 */
export function unlockAudio(): void {
  const c = getAudioCtx();
  if (c && c.state === 'suspended') {
    void c.resume().catch(() => {
      /* 解锁失败：蜂鸣器保持静音（视觉照常） */
    });
  }
}

/** 会话停止/页面卸载时释放（避免悬挂的 OscillatorNode 泄漏） */
export function closeAudio(): void {
  if (!ctx) return;
  void ctx.close().catch(() => {
    /* 已关闭 */
  });
  ctx = null;
}
