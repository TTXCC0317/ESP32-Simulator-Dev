# ESP32 网页版终端模拟器

自制一款基于网页的 ESP32 终端模拟器：根据硬件接线布局，在固件烧录前在线模拟硬件运行，观察外设行为与串口输出。

支持 MicroPython 与 Arduino C++（编译为固件）两类开发方式，**双引擎并行**：

- **引擎A**：浏览器内 MicroPython-WASM，零延迟交互，纯前端运行；
- **引擎B**：服务端 QEMU + WebSocket 桥，运行 Arduino/ESP-IDF 编译固件。

## 快速上手

### 环境要求

| 组件        | 版本                                       | 必需               |
| ----------- | ------------------------------------------ | ------------------ |
| Node.js     | 22.13+（22 LTS，pnpm 11 最低要求）         | ✅                 |
| pnpm        | 11+（corepack 按 packageManager 自动固定） | ✅                 |
| Git         | 2.x                                        | ✅                 |
| 浏览器      | Chrome / Edge 最新两个大版本               | ✅                 |
| Python      | 3.11+                                      | 仅引擎B（esptool） |
| arduino-cli | 官方安装脚本                               | 仅引擎B            |
| QEMU        | Espressif fork / lcgamboa fork             | 仅引擎B            |

> 引擎A 不依赖任何外部工具链，开箱即用；引擎B 缺工具链时入口置灰，引擎A 完整可用。

### 启动

```bash
# 1. 检测本机环境（不自动安装，缺项给指引）
pnpm install
pnpm setup            # 等价 tools/setup-toolchain.ps1

# 2. 拷贝配置模板
cp config/app.example.json config/app.json
# 按本机工具链路径修改 config/app.json 的 tools 字段

# 3. 一键启动（web 5173 + server 3001，开发期 Vite 代理 /api 与 /ws）
pnpm dev

# 4. 浏览器访问
open http://localhost:5173

# 生产构建（可选）
pnpm build
pnpm --filter server start   # http://localhost:3001，静态托管前端 dist
```

### Docker 一键部署（P2 终验后）

```bash
docker compose up -d          # 镜像构建在 GitHub Actions release.yml
open http://localhost:3001
```

详见《02-实施方案》§8 发布与部署。

## 文档导航

所有设计文档在 [`documents/`](./documents) 目录：

| 编号 | 文档                                                   | 内容                                                    |
| ---- | ------------------------------------------------------ | ------------------------------------------------------- |
| 01   | [总体设计方案](./documents/01-总体设计方案.md)         | 架构/前端/后端/数据库/配置/外设矩阵/风险/License        |
| 02   | [实施方案](./documents/02-实施方案.md)                 | 双引擎并行里程碑（M0-M15）、测试总纲、Git/CI/日志/部署  |
| 03   | [核心模块详细设计](./documents/03-核心模块详细设计.md) | shared 类型、PinBus、双引擎实现、Worker 协议、IndexedDB |
| 04   | [UI 详细设计](./documents/04-UI详细设计.md)            | 布局规格、控件、交互状态机、Monaco/Konva 实现细节、i18n |
| 05   | [元件清单](./documents/05-元件清单.md)                 | P1/P2 元件引脚/属性/封装/行为/SVG 规范                  |
| 06   | [边界说明](./documents/06-边界说明.md)                 | 功能/精度/规模/资源/安全/错误边界、安全测试             |

里程碑节奏：**P1（M0-M6）基础闭环 → P2（M7-M12）完整套件 → P3（M13-M15）进阶**。
当前进度：**P1 已完成并验收通过**（M0-M6 基础闭环，验收报告见 [documents/P1-验收报告.md](./documents/P1-验收报告.md)），下一阶段 P2 自 M7（PWM/ADC）起。

## 当前能力（P1 已交付）

- **电路画布**：元件拖放/选中/移动/旋转/删除、20px 网格吸附、缩放平移；引脚拖出正交连线（8 色循环、锚点编辑）；属性面板动态表单；diagram.json 画布⇄JSON 双向同步，兼容导入 Wokwi 简单工程；
- **工程管理**：SQLite 持久化（WAL）、工程列表（新建/打开/复制/删除）、JSON 包导入导出、启动种子示例；路径穿越防护；
- **P1 元件集**：ESP32 DevKit-C V4 板卡、LED、RGB LED、按键、电阻、电位器、滑动开关、有源蜂鸣器（完整规格见《05-元件清单》）；
- **双引擎仿真**（同一电路同一剧本双引擎可跑）：
  - 引擎A：MicroPython-WASM 浏览器内运行（`machine.Pin` 输入/输出、`Pin.irq`、`machine.UART(0)` shim）；
  - 引擎B：arduino-cli 编译（队列/日志流/错误定位）→ esptool merge_bin → QEMU 运行，工具链缺失时入口置灰；
- **串口终端**：xterm.js，波特率设置、ANSI 显示、输入发送、2MB 环形缓冲；
- **GPIO 输入输出闭环**：LED/RGB/蜂鸣器随固件实时渲染，按键/开关点击注入双引擎（PinBus 网络聚合 + 上拉/下拉语义）；
- **质量基建**：Golden 一致性测试（blink + button-led × 2 引擎全过）、性能复核 CLI（串口满速零丢行 / 4 并发 30 分钟 / 引擎A 突发延迟与持续吞吐）、Playwright E2E 骨架、GitHub Actions CI（lint/typecheck/test）。

## 仓库结构

```
ESP32Simulator/
├── documents/        # 设计文档（01-06 + P1-验收报告）
├── apps/
│   ├── web/          # 前端 React 18 + Vite + TS（含 sim/mpy wasm 产物）
│   └── server/      # 后端 Fastify + better-sqlite3（编译/QEMU/golden/perf）
├── packages/shared/ # 前后端共享类型与 zod schema
├── config/           # app.json + boards/ + parts/
├── examples/         # 内置示例（blink / button-led，含 golden.json 测试剧本）
├── tools/            # setup-toolchain.ps1 / mpy-build/（wasm 构建）/ bridge-glue/（引擎B GPIO 桥）/ seed-test-db.ps1
├── .github/          # CI workflows（ci.yml / e2e.yml / relay-emsdk.yml）
├── AGENTS.md         # AI 编码 agent 工作规范
├── LICENSE           # MIT
├── NOTICE.md         # 第三方资源归属
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## 主要技术栈

| 层    | 选型                                                                                |
| ----- | ----------------------------------------------------------------------------------- |
| 前端  | React 18 + TypeScript + Vite + react-konva + Monaco + xterm.js + Zustand + Tailwind |
| 后端  | Node.js 22 + Fastify + better-sqlite3 + zod + execa + pino                          |
| 引擎A | MicroPython 官方 webassembly port + 自定义 machine shim                             |
| 引擎B | arduino-cli + esptool + QEMU（Espressif fork / lcgamboa fork）                      |
| 工程  | pnpm Monorepo + GitHub Actions CI + Conventional Commits                            |

## 常用脚本

```bash
pnpm dev              # 启动开发环境
pnpm build            # 构建生产产物
pnpm lint             # ESLint 检查
pnpm lint:fix         # ESLint 自动修复
pnpm format           # Prettier 格式化
pnpm format:check     # Prettier 校验（CI 同款）
pnpm typecheck        # 全包 tsc --noEmit
pnpm test             # vitest 单元/组件/集成测试
pnpm e2e              # Playwright E2E（里程碑验收前）
pnpm golden           # Golden 仿真一致性测试（--example <id> --engine both|qemu-remote|micropython-wasm）
pnpm perf             # 性能复核（--suite serial|concurrent|enginea|all）
```

> 示例：`pnpm golden --example button-led --engine both` 跑 button-led 双引擎一致性；`pnpm perf --suite enginea` 复核引擎A GPIO 突发延迟 + 持续吞吐。

## License

MIT — 详见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)（第三方资源归属）。

arduino-cli（AGPL-3.0）与 QEMU（GPL-2.0）作为**外部工具链**调用，不链接进项目代码，不分发其本体。
