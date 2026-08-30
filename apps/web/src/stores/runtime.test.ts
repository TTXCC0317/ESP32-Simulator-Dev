import { describe, it, expect, beforeEach } from 'vitest';
import { useRuntimeStore } from './runtime';

/** L1（02-§4 M5 测试项）：元件运行时状态（两引擎 gpio.write/pwm.duty 汇聚） */

beforeEach(() => {
  useRuntimeStore.getState().clear();
});

describe('runtimeStore（M5 元件渲染数据源）', () => {
  it('applyGpio：写 GPIO 编号电平，Map 引用替换触发 selector', () => {
    const before = useRuntimeStore.getState().gpioLevels;
    useRuntimeStore.getState().applyGpio(4, 1);
    const s = useRuntimeStore.getState();
    expect(s.gpioLevels).not.toBe(before);
    expect(s.gpioLevels.get(4)).toBe(1);
    expect(s.gpioLevels.get(2)).toBeUndefined();
  });

  it('applyGpio 同引脚覆盖为最新电平', () => {
    useRuntimeStore.getState().applyGpio(4, 1);
    useRuntimeStore.getState().applyGpio(4, 0);
    expect(useRuntimeStore.getState().gpioLevels.get(4)).toBe(0);
  });

  it('applyPwm：记录 duty/freq；与 gpioLevels 独立', () => {
    useRuntimeStore.getState().applyPwm(4, 512, 1000);
    const s = useRuntimeStore.getState();
    expect(s.pwmDuties.get(4)).toEqual({ duty: 512, freq: 1000 });
    expect(s.gpioLevels.size).toBe(0);
  });

  it('clear：attach 新会话时清空上一轮状态', () => {
    useRuntimeStore.getState().applyGpio(4, 1);
    useRuntimeStore.getState().applyPwm(4, 512, 1000);
    useRuntimeStore.getState().clear();
    const s = useRuntimeStore.getState();
    expect(s.gpioLevels.size).toBe(0);
    expect(s.pwmDuties.size).toBe(0);
  });
});
