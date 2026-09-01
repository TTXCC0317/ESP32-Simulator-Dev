import { create } from 'zustand';

/**
 * 元件运行时状态（03-§6.2 视图层，M5）：两引擎 gpio.write/pwm.duty 事件汇聚。
 * key 为板卡 GPIO 编号（引擎A shim 与引擎B GPIO 桥统一语义）；
 * 元件渲染经 net-map 的 PinRef→GPIO 映射消费（PartLayer）。
 * Map 引用每次更新替换，保证 zustand selector 按值重算。
 *
 * M9 显示事件（S3）：
 * - fb.update（SSD1306 128×64 单色）：partId → 全帧位图（页主序 fb[page*128+col]，
 *   每字节 8 个垂直像素 LSB=上，与 glue FB_TXN 段布局一致），增量 rect 原地合并；
 * - neopixel.write（WS2812）：partId → RGB 字节序列（3×N，WS 层已 GRB→RGB 归一）。
 */

export interface PwmState {
  duty: number;
  freq: number;
}

/** SSD1306 几何（05-§1.9）：128 列 × 8 页 × 8 行 */
export const SSD1306_COLS = 128;
export const SSD1306_PAGES = 8;
export const SSD1306_FB_BYTES = SSD1306_COLS * SSD1306_PAGES; // 1024

interface RuntimeStore {
  gpioLevels: Map<number, 0 | 1>;
  pwmDuties: Map<number, PwmState>;
  /** partId → SSD1306 全帧位图（1024B，页主序） */
  fbFrames: Map<string, Uint8Array>;
  /** partId → NeoPixel RGB 字节（3×N） */
  neopixelFrames: Map<string, Uint8Array>;
  applyGpio: (pin: number, level: 0 | 1) => void;
  applyPwm: (pin: number, duty: number, freq: number) => void;
  /** fb.update 增量合并：rect=[x,y,w,h]，data 为页行位图（每字节 8 垂直像素 LSB=上） */
  applyFb: (partId: string, rect: [number, number, number, number], data: Uint8Array) => void;
  applyNeopixel: (partId: string, pixels: Uint8Array) => void;
  clear: () => void;
}

export const useRuntimeStore = create<RuntimeStore>((set) => ({
  gpioLevels: new Map(),
  pwmDuties: new Map(),
  fbFrames: new Map(),
  neopixelFrames: new Map(),

  applyGpio: (pin, level) =>
    set((s) => {
      const gpioLevels = new Map(s.gpioLevels);
      gpioLevels.set(pin, level);
      return { gpioLevels };
    }),

  applyPwm: (pin, duty, freq) =>
    set((s) => {
      const pwmDuties = new Map(s.pwmDuties);
      pwmDuties.set(pin, { duty, freq });
      return { pwmDuties };
    }),

  applyFb: (partId, rect, data) =>
    set((s) => {
      const [x, y, w, h] = rect;
      if (w <= 0 || h <= 0) return {};
      const fbFrames = new Map(s.fbFrames);
      const prev = fbFrames.get(partId);
      const fb = prev !== undefined ? new Uint8Array(prev) : new Uint8Array(SSD1306_FB_BYTES);
      if (fb.length !== SSD1306_FB_BYTES) return {}; // 非法帧丢弃
      /* FB_TXN 段布局（glue ssd_flush_run）：单页行 h=8，data[i] = 列 x+i 的页位图；
       * 通用化：按列写入每个 8 像素页行（y/8 + j，j < h/8） */
      const pageRows = Math.max(1, Math.floor(h / 8));
      for (let i = 0; i < w; i++) {
        for (let j = 0; j < pageRows; j++) {
          const src = data[j * w + i];
          if (src === undefined) continue;
          const col = x + i;
          const page = Math.floor(y / 8) + j;
          if (col < 0 || col >= SSD1306_COLS || page < 0 || page >= SSD1306_PAGES) continue;
          fb[page * SSD1306_COLS + col] = src;
        }
      }
      fbFrames.set(partId, fb);
      return { fbFrames };
    }),

  applyNeopixel: (partId, pixels) =>
    set((s) => {
      const neopixelFrames = new Map(s.neopixelFrames);
      neopixelFrames.set(partId, pixels);
      return { neopixelFrames };
    }),

  clear: () =>
    set({
      gpioLevels: new Map(),
      pwmDuties: new Map(),
      fbFrames: new Map(),
      neopixelFrames: new Map(),
    }),
}));
