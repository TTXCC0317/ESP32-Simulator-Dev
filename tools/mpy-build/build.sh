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

# emscripten 4.x 兼容：library.js 的 mp_js_hook 经 ccall 调 0 参导出函数
# （mp_hal_get_interrupt_char / mp_sched_keyboard_interrupt）时用 ["null"] 占位，
# 3.1.x 静默忽略多余实参，4.0.x 的 createExportWrapper 断言 abort（Asyncify
# 挂起/恢复路径必经，表现为高频 sleep 循环中断）。修正为无参调用（上游 v1.26
# 对 emscripten 4.0 的适配 bug）。
if ! grep -q "ESP32Sim patch" "$PORT/library.js"; then
  python3 - "$PORT/library.js" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
n = 0
for old, new in [
    ('''                "mp_hal_get_interrupt_char",
                "number",
                ["number"],
                ["null"],
            );''',
     '''                "mp_hal_get_interrupt_char",
                "number",
                [], /* ESP32Sim patch: 0-arg export, emscripten 4.x arity assert */
                [],
            );'''),
    ('''                            "mp_sched_keyboard_interrupt",
                            "null",
                            ["null"],
                            ["null"],
                        );''',
     '''                            "mp_sched_keyboard_interrupt",
                            "null",
                            [], /* ESP32Sim patch: 0-arg export, emscripten 4.x arity assert */
                            [],
                        );'''),
]:
    if old in s:
        s = s.replace(old, new, 1)
        n += 1
open(p, 'w').write(s)
print(f'library.js arity patch applied ({n}/2)')
PYEOF
  echo "=== library.js arity patch applied ==="
fi

# 禁用 Node stdin 轮询 hook（standard variant 默认开启）：VM 每 10 条字节码经
# ccall 同步进出 JS 再进 wasm，与 ASYNCIFY 挂起/恢复重放叠加会损坏 Asyncify
# 状态机（稳定复现于第 8 次挂起恢复后 native crash）。引擎A 的 Ctrl-C 停止走
# 导出的 mp_sched_keyboard_interrupt（engine.ts 直接调用），不依赖该 hook。
if ! grep -q "ESP32Sim patch: disable JS hook" "$PORT/variants/standard/mpconfigvariant.h"; then
  printf '\n/* ESP32Sim patch: disable JS hook (ASYNCIFY re-entry crash, see build.sh) */\n#undef MICROPY_VARIANT_ENABLE_JS_HOOK\n#define MICROPY_VARIANT_ENABLE_JS_HOOK (0)\n' >> "$PORT/variants/standard/mpconfigvariant.h"
  echo "=== JS hook disabled ==="
fi

# 探测 JS 侧需要的 C API 符号（03-§3.3：停止中断 / stdout / 执行入口）。
# 探测结果仅作诊断日志；实际导出走下方 port 的 *_EXTRA 扩展点（v1.26 Makefile
# 已含 do_exec/register_js_module 等导出，我们仅需补充 gpio_inject 与 HEAPU8）。
echo "=== probe exported API symbols ==="
EXPORTS="_main"
for fn in mp_js_init mp_js_do_str mp_js_init_repl mp_js_process_char mp_keyboard_interrupt mp_js_register_js_module mp_js_gpio_inject; do
  if grep -rqs "\b$fn(" /mpy/py/*.c /mpy/py/*.h "$PORT"/*.c "$PORT"/*.h; then
    EXPORTS="$EXPORTS,_$fn"
  fi
done
echo "EXPORTED_FUNCTIONS: $EXPORTS"

# 追加链接参数：JS 文件系统（VFS 写入 main.py）+ API 导出。
# 注意：链接命令为 emcc $(LDFLAGS) -o $@ $(OBJ) $(JSFLAGS)——JSFLAGS 位于命令行
# 末尾，port 自带的 -s EXPORTED_RUNTIME_METHODS/EXPORTED_FUNCTIONS 会覆盖 LDFLAGS
# 中同名参数（emscripten 4.0.7 起 HEAP* views 不再默认挂到 Module）。因此导出类
# 参数必须走 port 的 *_EXTRA 扩展点；非导出类参数放 LDFLAGS/JSFLAGS 均可。
# ASYNCIFY_STACK_SIZE：默认 4096B 对 MicroPython 编译期深 C 栈余量不足（挂起保存
# 整段 wasm 栈），显式加大到 64KB；mp_hal_delay_ms 经 emscripten_sleep 挂起让出事件循环。
if ! grep -q "ESP32SIM_LINKER_ADDITIONS" Makefile; then
  printf '\n# --- ESP32Sim linker additions (M4, 03-SS3.3/3.4) ---\nEXPORTED_RUNTIME_METHODS_EXTRA += ,HEAPU8,HEAPU32\nEXPORTED_FUNCTIONS_EXTRA += ,_mp_js_gpio_inject\nJSFLAGS += -s FORCE_FILESYSTEM -s ASYNCIFY_STACK_SIZE=65536\n' >> Makefile
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
