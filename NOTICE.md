# NOTICE — 第三方资源归属

本项目（ESP32 Simulator，MIT License）依赖与复用以下第三方资源。

## 运行时依赖（npm 包）

| 依赖                                 | License | 用途         |
| ------------------------------------ | ------- | ------------ |
| react / react-dom                    | MIT     | UI 框架      |
| react-konva / konva                  | MIT     | 画布         |
| zustand                              | MIT     | 状态管理     |
| @monaco-editor/react / monaco-editor | MIT     | 代码编辑器   |
| @xterm/xterm / @xterm/addon-fit      | MIT     | 串口终端     |
| tailwindcss                          | MIT     | 样式         |
| nanoid                               | MIT     | ID 生成      |
| fastify / @fastify/*                 | MIT     | 后端 HTTP/WS |
| better-sqlite3                       | MIT     | SQLite 驱动  |
| zod                                  | MIT     | schema 校验  |
| execa                                | MIT     | 子进程调用   |
| pino / pino-roll                     | MIT     | 日志         |

## 复用源（代码 / 资源）

| 资源                          | 来源                                       | License | 复用方式                                                                           |
| ----------------------------- | ------------------------------------------ | ------- | ---------------------------------------------------------------------------------- |
| `wokwi-elements` SVG 路径数据 | https://github.com/wokwi/wokwi-elements    | MIT     | 部分元件 SVG 路径数据参照复刻，已转换为本项目坐标体系                              |
| MicroPython 源码              | https://github.com/micropython/micropython | MIT     | 经 Emscripten 编译为 `micropython.wasm`（构建参数见 `tools/mpy-build/Dockerfile`） |

## 外部工具链（不链接进本项目）

| 工具                                   | License                             | 集成方式                                       |
| -------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| arduino-cli                            | AGPL-3.0                            | execa spawn 外部子进程；不分发本体，仅引导安装 |
| QEMU（Espressif fork / lcgamboa fork） | GPL-2.0                             | execa spawn 外部子进程；不分发本体             |
| Emscripten                             | MIT / University of Illinois / NCSA | 仅 MicroPython 构建期工具链；产物分发按 MIT    |

## WASM 产物入库声明

`apps/web/src/sim/mpy/micropython.wasm` 与 `micropython.wasm.mjs`（M4 起构建后入库）经 Emscripten 编译 MicroPython 源码（MIT）+ 本仓库 `machine-shim`（MIT）而来，按 MIT License 分发。

构建参数（commit hash + emsdk 版本）记录于 `apps/web/src/sim/mpy/LICENSE`（M4 起随构建产物一并入库）。

## Docker 镜像边界

Docker 镜像（`apps/server` + `apps/web/dist`）不分发 arduino-cli / QEMU / Emscripten 二进制本体，仅声明安装路径与构建脚本（见 `tools/setup-toolchain.ps1`），避免触发 AGPL/GPL 义务。
