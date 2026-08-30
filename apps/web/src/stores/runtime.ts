import { create } from 'zustand';

/**
 * 元件运行时状态（03-§6.2 视图层，M5）：两引擎 gpio.write/pwm.duty 事件汇聚。
 * key 为板卡 GPIO 编号（引擎A shim 与引擎B GPIO 桥统一语义）；
 * 元件渲染经 net-map 的 PinRef→GPIO 映射消费（PartLayer）。
 * Map 引用每次更新替换，保证 zustand selector 按值重算。
 */

export interface PwmState {
  duty: number;
  freq: number;
}

interface RuntimeStore {
  gpioLevels: Map<number, 0 | 1>;
  pwmDuties: Map<number, PwmState>;
  applyGpio: (pin: number, level: 0 | 1) => void;
  applyPwm: (pin: number, duty: number, freq: number) => void;
  clear: () => void;
}

export const useRuntimeStore = create<RuntimeStore>((set) => ({
  gpioLevels: new Map(),
  pwmDuties: new Map(),

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

  clear: () => set({ gpioLevels: new Map(), pwmDuties: new Map() }),
}));
