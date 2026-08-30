# AGENTS.md — AI 编码 Agent 工作规范

> 本文件供 AI 编码 agent（Claude Code / Cursor / Trae / Codex 等）在本仓库工作时遵循。任何 agent 在写代码前应先读此文件 + `documents/01~06`。

## 项目背景

网页版 ESP32 终端模拟器（参照 Wokwi），双引擎并行：

- 引擎A = 浏览器内 MicroPython-WASM（前端运行，零延迟）；
- 引擎B = 服务端 QEMU + WebSocket 桥（运行 Arduino/ESP-IDF 编译固件）。

前后端分离 + pnpm Monorepo，单机定位（SQLite，无用户体系）。详细方案见 `documents/`。

## 技术栈与硬约束

| 维度  | 选型                                                                        | 约束                                                           |
| ----- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 前端  | React 18 + TS + Vite + react-konva + Monaco + xterm.js + Zustand + Tailwind | 不引入 redux/mobx；状态走 zustand                              |
| 后端  | Node 22 + Fastify + better-sqlite3 + zod + execa + pino                     | 不引入 express/sequelize；ORM 直接用 better-sqlite3 同步 API   |
| 引擎A | MicroPython webassembly port + 自定义 machine shim                          | wasm 产物入库 `apps/web/src/sim/mpy/`，不在开发机装 Emscripten |
| 引擎B | arduino-cli + QEMU（Espressif fork / lcgamboa fork）                        | 作为外部进程 spawn，不链接；命令参数必须数组化（execa）        |
| 测试  | vitest + @testing-library/react + Playwright + fastify.inject               | 不引入 jest                                                    |
| CI    | GitHub Actions                                                              | 不引入 Jenkins                                                 |

**禁止**：自由选型引入新依赖前必须在 PR 描述里说明理由 + License 兼容性（见 `documents/01-总体设计方案.md` §12 License）。

## 工作流

### Git 分支（见 `documents/02-实施方案.md` §3.6）

- **单人开发期（当前）**：允许直推 `main`；push 前本地 lint + typecheck + test 全绿，CI push 复核，红即修；
- 大改动/实验性改动用功能分支 `feat/<scope>-<topic>`（修复 `fix/<topic>`，文档 `docs/<topic>`），多人期恢复 main 只接 PR；
- Conventional Commits：`feat:`/`fix:`/`docs:`/`refactor:`/`test:`/`chore:`；
- PR 模板在 `.github/pull_request_template.md`（多人期/大改动 PR 时必填"实现范围/测试项/验收点"三要素）。

### CI（见 §3.1.1）

- `ci.yml`（PR/push）：lint + typecheck + test 三 Job，任一失败阻塞 merge；
- `e2e.yml`（里程碑验收前手动 dispatch）：Playwright + Golden 测试。

### 编码规范（见 §3.4.1）

- ESLint flat config：`@eslint/js` + `typescript-eslint/strict` + react-hooks + react-refresh；
- Prettier：`printWidth: 100`，`singleQuote`，`trailingComma: all`，`endOfLine: lf`；
- pre-commit 钩子跑 lint-staged（`simple-git-hooks`，不用 husky）。

## 任务模板

接到里程碑子任务时，agent 应：

1. **先读对应文档**： milestones 在 `documents/02-实施方案.md` §4；模块签名在 `documents/03-核心模块详细设计.md`；UI 在 `documents/04-UI详细设计.md`；元件在 `documents/05-元件清单.md`；边界在 `documents/06-边界说明.md`；
2. **核对 packages/shared**：任何 WS/REST/Circuit 类型变更必须同步 `documents/03-核心模块详细设计.md` §2 类型签名 + §2.5 zod schema；
3. **写测试**：按 §3.1 测试分层补 L1-L3 用例；里程碑验收前补 L4/L5；
4. **遵守边界**：规模/资源/安全边界见 `documents/06-边界说明.md`，不要"为了方便"放宽（如允许 shell 拼接、放宽消息速率限制）；
5. **PR 描述**：对照里程碑"实现范围/测试项/验收标准"三要素逐条勾选完成情况。

## 常见坑

- **esp32 core 3.x GPIO HAL 是 weak alias**：`digitalWrite`/`pinMode` 等是 `__digitalWrite` 等的 weak alias（`esp32-hal-gpio.c`），`-Wl,--wrap` 只重定向 undefined reference、对 weak alias 静默失效（`__wrap_*` 被 `--gc-sections` 丢弃，链接照样成功）——拦截 Arduino HAL 必须用 glue 强符号覆盖（见 `tools/bridge-glue/esp32sim_bridge.c`、03-§7.2.2）；
- **QEMU 不模拟 GPIO 内部上/下拉**：悬空输入经 `__digitalRead` 恒读 0（上拉按键"幻象按下"）——glue 桥按固件 pinMode 声明维护 pull 表，无注入时按声明电平返回（见 03-§7.2.2）；
- **QEMU 双核缓存仿真偶发 flake**：Espressif fork 偶发 "Guru Meditation Error: Cache error" panic——网关扫描串口日志自动 respawn 会话 1 次，连续复现转 error 提示手动重试（见 06-§3）；
- **react-konva 不支持 HTML5 DnD**：拖拽用 pointer 事件模拟（见 04 §4 D1）；
- **Monaco 在 Vite 下要配 worker**：用 `?worker` 后缀导入（见 04 §7.1 C3）；
- **wasm 加载**：用 `vite-plugin-wasm` + `?url`，COOP/COEP 头启用 SharedArrayBuffer（见 03 §3.4）；
- **板卡左右列同名引脚**：PinRef 不带列后缀，Union-Find 自动聚合（见 05 §1.1.1）；
- **AudioContext 需用户手势解锁**：首次点 ▶ 运行时 `audioCtx.resume()`（见 05 §1.8 E4）；
- **SQLite 单机**：better-sqlite3 同步 API，不要写异步封装；前端缓存走 IndexedDB 不走 SQLite（见 03 §6.4）；
- **路径穿越**：工程路径规范化后强制限制 `data/` 目录（见 06 §6 + §6.1）。

## 文档同步责任

任何代码改动若触及以下，必须**同步修改对应文档章节**（PR 内一并提交）：

- WS/REST 协议字段 → `documents/03-核心模块详细设计.md` §2 + §2.5；
- 元件引脚/属性/行为 → `documents/05-元件清单.md`；
- 边界数值（规模/超时/速率）→ `documents/06-边界说明.md` §3/§4 + `documents/01-总体设计方案.md` §7.6 app.example.json；
- 新增里程碑/调整验收标准 → `documents/02-实施方案.md` §4。

文档与代码偏离是技术债，CI 不强制（无法静态检测），靠 PR Reviewer 把关。
