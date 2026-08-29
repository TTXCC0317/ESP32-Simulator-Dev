#!/bin/sh
# MicroPython-WASM 定制构建（02-§5.3.1）
# 在 emscripten/emsdk 容器内执行；产物拷贝到 /out（宿主经 docker -v 挂载）。
set -e

# submodules（micropython-lib/libm 等；容器内经 gh-proxy 加速，可用环境变量覆盖）
GH_PROXY="${GH_PROXY:-https://v4.gh-proxy.org/https://github.com/}"
git config --global url."${GH_PROXY}".insteadOf "https://github.com/" || true
make submodules

PORT=/mpy/ports/webassembly
cd "$PORT"

echo "=== probe: webassembly port files ==="
ls -1 "$PORT" | head -40

echo "=== probe: existing machine module registration ==="
if grep -rn "MP_REGISTER_MODULE" "$PORT" | grep -w "MP_QSTR_machine"; then
  echo "WARNING: port already registers a machine module; shim injection may conflict"
else
  echo "(port has no machine module, safe to inject shim)"
fi

echo "=== probe: Makefile SRC_C ==="
grep -n "SRC_C" Makefile || true

# 注入 machine shim（若 Makefile 未含 machine.c）
# 关键：SRC_C += 必须发生在 OBJ 计算行（addprefix）之前——prerequisite 在 make
# 读入期展开，末尾追加会导致 machine.o 永不被编译、链接期缺失。
if ! grep -q "machine.c" Makefile; then
  cp /machine-shim/machine.c "$PORT/machine.c"
  python3 - "$PORT/Makefile" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
anchor = 'OBJ += $(addprefix $(BUILD)/, $(SRC_C:.c=.o))'
if 'machine.c' not in s and anchor in s:
    s = s.replace(anchor, 'SRC_C += machine.c\n' + anchor, 1)
    open(p, 'w').write(s)
    print('machine.c injected before OBJ line')
else:
    print('anchor not found or already injected', anchor in s)
PYEOF
  echo "=== machine shim injected ==="
fi

# time.sleep 非阻塞化（03-§3.3）：官方 mp_hal_delay_ms 为忙等，会冻结 JS 线程
# （Node golden / 浏览器 Worker 均被阻塞，停止/重置失效）。port 已启用 ASYNCIFY
# （产物含 Asyncify 运行时），改走 emscripten_sleep 让出 JS 事件循环。
# delay_us 保持忙等（亚毫秒级短等待，挂起开销不划算）。
if ! grep -q "emscripten_sleep" "$PORT/mphalport.c"; then
  python3 - "$PORT/mphalport.c" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
old = '''void mp_hal_delay_ms(mp_uint_t ms) {
    uint32_t start = mp_hal_ticks_ms();
    while (mp_hal_ticks_ms() - start < ms) {
    }
}'''
new = '''#include <emscripten.h>
void mp_hal_delay_ms(mp_uint_t ms) {
    emscripten_sleep(ms); /* ESP32Sim patch: ASYNCIFY 挂起，让出 JS 事件循环 */
}'''
if old in s:
    open(p, 'w').write(s.replace(old, new, 1))
    print('mp_hal_delay_ms -> emscripten_sleep patched')
else:
    print('WARN: mp_hal_delay_ms pattern not found, keep busy-wait')
PYEOF
  echo "=== mphalport sleep patch applied ==="
fi

# 探测 JS 侧需要的 C API 符号（03-§3.3：停止中断 / stdout / 执行入口），
# 只导出真实存在的符号（emcc 对未知导出符号会链接失败）
echo "=== probe exported API symbols ==="
EXPORTS="_main"
for fn in mp_js_init mp_js_do_str mp_js_init_repl mp_js_process_char mp_keyboard_interrupt mp_js_register_js_module; do
  if grep -rqs "\b$fn(" /mpy/py/*.c /mpy/py/*.h "$PORT"/*.c "$PORT"/*.h; then
    EXPORTS="$EXPORTS,_$fn"
  fi
done
echo "EXPORTED_FUNCTIONS: $EXPORTS"

# 追加链接参数：JS 文件系统（VFS 写入 main.py）+ ccall/FS 运行时方法 + API 导出
if ! grep -q "ESP32SIM_LDFLAGS" Makefile; then
  printf '\n# --- ESP32Sim linker additions (M4, 03-SS3.3/3.4) ---\nLDFLAGS += -sFORCE_FILESYSTEM -sEXPORTED_RUNTIME_METHODS=ccall,ccall_unsafe,FS,HEAPU8 -sEXPORTED_FUNCTIONS=%s\n' "$EXPORTS" >> Makefile
  echo "=== linker flags appended ==="
fi

echo "=== build start ==="
make -j"$(nproc)"

echo "=== collect artifacts ==="
mkdir -p /out
ls -la build-*/ 2>/dev/null || ls -la build/
for f in build-*/micropython.wasm build-*/micropython.mjs build-*/micropython.wasm.mjs \
         micropython.wasm micropython.mjs micropython.wasm.mjs; do
  [ -f "$f" ] && cp "$f" /out/ && echo "copied $f"
done
echo "=== /out contents ==="
ls -la /out
