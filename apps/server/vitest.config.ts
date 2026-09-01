import { defineConfig } from 'vitest/config';

/**
 * 关闭文件级并行（文件内用例仍并行）。
 *
 * 原因：QemuManager 串口端口池 40000-41000 被多个测试文件共享
 * （qemu.manager.test / ws-gateway.test 的 FakeChild 都会真实 listen），
 * allocPort 的"探测空闲→关闭探针→子进程绑定"存在 TOCTOU 窗口；
 * 多 worker 并行时两个文件同时探测同一端口均判空闲 → EADDRINUSE
 * 未捕获异常 → vitest 以 exit 1 退出（321 用例全过仍判失败，
 * GitHub Actions 4 核 runner 偶发，2 核本地难以复现）。
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
