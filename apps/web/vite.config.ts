/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// dev 代理：/api → Fastify 3001；/ws → WebSocket 升级（01-§5.1 端口约定）
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // EngineWorker 用 ES module 形式（03-§3.4 C1：new Worker(url, {type:'module'})）
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
      },
    },
  },
  // preview（生产构建预览，L4 E2E 用）：代理与 dev 一致（02-§3.5 首屏/帧率在 prod 构建
  // 下测量；vite preview 不继承 server.proxy，需单独声明）
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
      },
    },
  },
  build: {
    // Monaco 接入后按 04-§7.1 C3 加 manualChunks 单独切 chunk
    // esnext：worker ES format 与动态 import wasm glue 需要
    target: 'esnext',
    sourcemap: true,
  },
  test: {
    // 默认 jsdom（L2 组件测试）；纯逻辑测试可用 // @vitest-environment node 覆盖
    environment: 'jsdom',
  },
});
