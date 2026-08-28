import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfigSchema } from './schema';
import { loadConfig, ConfigError } from './loader';

/**
 * L1：AppConfig schema 缺省值补齐与非法值拒绝（数值边界 ↔ 06-§3/§4/§7.1.1），
 * 以及 loadConfig 文件加载的三条失败路径（缺失 / 非 JSON / 校验失败）。
 */

describe('appConfigSchema 缺省值（01-§7.6 模板对齐）', () => {
  it('空对象解析出全部默认值', () => {
    const cfg = appConfigSchema.parse({});
    expect(cfg.server).toEqual({ port: 3001, host: '127.0.0.1', staticDistPath: '../web/dist' });
    expect(cfg.db).toEqual({ path: 'data/simulator.db', wal: true });
    expect(cfg.dataDir).toBe('data');
    expect(cfg.builds).toEqual({
      dir: 'data/builds',
      maxConcurrent: 2,
      timeoutMs: 300_000,
      quotaMb: 2048,
    });
    expect(cfg.flash.sessionTimeoutMs).toBe(1_800_000);
    expect(cfg.tools).toEqual({
      arduinoCli: 'arduino-cli',
      esp32Core: 'esp32:esp32',
      esptool: 'esptool',
      qemuXtensa: '',
      qemuRiscv32: '',
    });
    expect(cfg.ws.maxConcurrentSessions).toBe(4);
    expect(cfg.ws.maxMsgBytes).toBe(1_048_576);
    expect(cfg.ws.heartbeatIntervalMs).toBe(15_000);
    expect(cfg.limits.partsPerProject).toBe(120);
    expect(cfg.limits.connectionsPerProject).toBe(300);
    expect(cfg.sim).toEqual({ wasmMemMb: 256, speedOptions: [0.25, 0.5, 1, 2, 4] });
    expect(cfg.log).toEqual({ level: 'info', dir: 'logs', rotateMb: 10, rotateKeep: 5 });
  });

  it('覆盖部分字段时其余保持默认', () => {
    const cfg = appConfigSchema.parse({ server: { port: 4000 }, db: { wal: false } });
    expect(cfg.server.port).toBe(4000);
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.db.wal).toBe(false);
    expect(cfg.db.path).toBe('data/simulator.db');
  });
});

describe('appConfigSchema 非法值拒绝（06-§3/§4 边界）', () => {
  it.each([
    ['server.port=0', { server: { port: 0 } }],
    ['server.port>65535', { server: { port: 70_000 } }],
    ['builds.maxConcurrent=0', { builds: { maxConcurrent: 0 } }],
    ['builds.maxConcurrent 超上限', { builds: { maxConcurrent: 17 } }],
    ['ws.maxMsgBytes 超上限', { ws: { maxMsgBytes: 17 * 1024 * 1024 } }],
    ['limits.partsPerProject=0', { limits: { partsPerProject: 0 } }],
    ['log.level 未知值', { log: { level: 'verbose' } }],
    ['sim.speedOptions 非法档位', { sim: { speedOptions: [3] } }],
    ['sim.speedOptions 空数组', { sim: { speedOptions: [] } }],
  ])('拒绝 %s', (_label, input) => {
    expect(appConfigSchema.safeParse(input).success).toBe(false);
  });
});

describe('loadConfig（01-§7 配置加载）', () => {
  it('文件缺失抛 ConfigError 并给出引导信息', () => {
    expect(() => loadConfig('config/definitely-missing.json')).toThrow(ConfigError);
    expect(() => loadConfig('config/definitely-missing.json')).toThrow(/app\.example\.json/);
  });

  it('非法 JSON 抛 ConfigError', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const file = join(dir, 'app.json');
    writeFileSync(file, '{ not json');
    try {
      expect(() => loadConfig(file)).toThrow(ConfigError);
      expect(() => loadConfig(file)).toThrow(/不是合法 JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('最小合法配置加载成功且缺省段补齐', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const file = join(dir, 'app.json');
    writeFileSync(file, JSON.stringify({ server: { port: 3002 } }));
    try {
      const cfg = loadConfig(file);
      expect(cfg.server.port).toBe(3002);
      expect(cfg.db.path).toBe('data/simulator.db');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('校验失败时错误信息包含 zod issue 路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const file = join(dir, 'app.json');
    writeFileSync(file, JSON.stringify({ server: { port: 0 } }));
    try {
      expect(() => loadConfig(file)).toThrow(/配置校验失败[\s\S]*server\.port/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
