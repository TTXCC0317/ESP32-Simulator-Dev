# MicroPython-WASM 定制构建（02-§5.3.1）
# 用法（仓库根目录）：
#   docker build -t mpy-wasm-build tools/mpy-build/
#   docker run --rm -v "<仓库绝对路径>/apps/web/src/sim/mpy:/out" mpy-wasm-build
# 产物：micropython.wasm + micropython.mjs（Emscripten glue，官方 webassembly port 命名）
#
# 基础镜像：国内网络直连 docker.io 拉取 emsdk 失败时，先跑 relay-emsdk 工作流
# 中转到 GHCR（详见 .github/workflows/relay-emsdk.yml，包需设为 Public），
# 再以 --build-arg 覆盖：
#   docker build --build-arg EMSDK_IMAGE=ghcr.io/ttxcc0317/emsdk:3.1.45 \
#     -t mpy-wasm-build tools/mpy-build/

ARG EMSDK_IMAGE=emscripten/emsdk:4.0.10
FROM ${EMSDK_IMAGE}

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
