/**
 * 工程文件路径规范化与防穿越（《06-边界说明》§6 + §6.1 F4）
 *
 * project_files.path 为相对工程根的 POSIX 风格路径（如 `main.py`、`lib/ssd1306.py`）：
 * - 拒绝绝对路径、反斜杠、`..` 段、空段 → 返回 null（调用方映射 400 PATH_TRAVERSAL）；
 * - 去除冗余 `./` 前缀后返回规范化路径。
 */
export function normalizeProjectPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 255) return null;
  if (trimmed.includes('\\')) return null;
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return null;
  const segments = trimmed.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  if (out.length === 0) return null;
  const normalized = out.join('/');
  if (normalized.endsWith('/')) return null;
  return normalized;
}
