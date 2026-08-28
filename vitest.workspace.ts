import { defineWorkspace } from 'vitest/config';

/**
 * vitest workspace（02-§3.1 L1-L3 分层）：
 * 根目录 `pnpm test` 按包分项目执行，各项目加载自身 vite/vitest config——
 * apps/web 继承 vite.config.ts 的 test.environment=jsdom（L2 组件测试），
 * packages/shared 与 apps/server 无 config，使用默认 node 环境。
 */
// 注意：vitest 2.1.x 存在 glob 累积 bug（多条 glob 会重复匹配前面的目录），
// 必须写成单条 brace glob，避免 '@esp32-sim/shared' 项目名重复报错。
export default defineWorkspace(['{packages,apps}/*']);
