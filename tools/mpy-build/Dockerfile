# MicroPython-WASM 定制构建（02-§5.3.1）
# 用法（仓库根目录）：
#   docker build -t mpy-wasm-build tools/mpy-build/
#   docker run --rm -v "<仓库绝对路径>/apps/web/src/sim/mpy:/out" mpy-wasm-build
# 产物：micropython.wasm + micropython.mjs（Emscripten glue，官方 webassembly port 命名）

FROM emscripten/emsdk:3.1.45

# MicroPython 源码（固定 tag 便于复现；网络受限环境可用
#   --build-arg MPY_REPO=https://v4.gh-proxy.org/https://github.com/micropython/micropython.git
# 经代理加速）
ARG MPY_REPO=https://github.com/micropython/micropython.git
RUN git clone --depth 1 --branch v1.26.0 "${MPY_REPO}" /mpy

COPY build.sh /build.sh
COPY machine-shim/ /machine-shim/
RUN chmod +x /build.sh

WORKDIR /mpy/ports/webassembly
CMD ["/build.sh"]
