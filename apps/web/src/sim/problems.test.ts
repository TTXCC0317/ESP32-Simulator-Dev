import { describe, expect, it } from 'vitest';
import { parseCompileLine } from './problems';

/**
 * L1（04-§9 错误面板，M6）：编译诊断行解析——gcc/arduino-cli 定位行 → 结构化条目；
 * 非诊断行（进度/聚合输出）返回 null，走普通日志。
 */

describe('parseCompileLine（04-§9 编译错误定位）', () => {
  it('error 行：file:line:col: error: msg', () => {
    expect(
      parseCompileLine(
        'src/main/sketch/main.ino.cpp:12:5: error: xyz was not declared in this scope',
      ),
    ).toEqual({
      file: 'src/main/sketch/main.ino.cpp',
      line: 12,
      col: 5,
      severity: 'error',
      message: 'xyz was not declared in this scope',
    });
  });

  it('fatal error 行归一为 error', () => {
    expect(parseCompileLine('main.c:3:10: fatal error: Foo.h: No such file or directory')).toEqual({
      file: 'main.c',
      line: 3,
      col: 10,
      severity: 'error',
      message: 'Foo.h: No such file or directory',
    });
  });

  it('warning 行', () => {
    expect(parseCompileLine('main.cpp:1:1: warning: unused variable "x" [-Wunused]')).toEqual({
      file: 'main.cpp',
      line: 1,
      col: 1,
      severity: 'warning',
      message: 'unused variable "x" [-Wunused]',
    });
  });

  it('非诊断行返回 null（进度/聚合行走普通日志）', () => {
    expect(parseCompileLine('Compiling sketch.ino.cpp...')).toBeNull();
    expect(parseCompileLine('Using board esp32:esp32:esp32 from Arduino IDE')).toBeNull();
    expect(parseCompileLine('Linking everything together...')).toBeNull();
    expect(parseCompileLine('')).toBeNull();
  });
});
