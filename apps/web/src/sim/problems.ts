/**
 * 编译输出解析（04-§9 错误面板，M6）：arduino-cli/gcc 诊断行 → 结构化定位。
 * 典型格式：`src/main/sketch/main.ino.cpp:12:5: error: 'x' was not declared`；
 * `fatal error`/`warning` 同构；聚合行/纯文本行返回 null（作为普通日志处理）。
 */

export interface ParsedCompileLine {
  file: string;
  line: number;
  col: number;
  severity: 'error' | 'warning';
  message: string;
}

const DIAG_RE = /^(.+?):(\d+):(\d+):\s*(?:fatal\s+)?(error|warning):\s*(.+)$/;

export function parseCompileLine(raw: string): ParsedCompileLine | null {
  const m = DIAG_RE.exec(raw.trim());
  if (!m) return null;
  return {
    file: m[1] ?? '',
    line: Number(m[2]),
    col: Number(m[3]),
    severity: m[4] === 'warning' ? 'warning' : 'error',
    message: m[5] ?? '',
  };
}
