import { z } from 'zod';

/**
 * config/app.json 校验 schema（字段与默认值对齐 01-§7.6 app.example.json 模板）
 *
 * 所有顶层段均可缺省（解析时填默认值）；数值边界来源：
 * - ws.*   ↔《06-边界说明》§7.1.1 / §6
 * - limits.* ↔《06-边界说明》§3
 * - builds.* / flash.* ↔《06-边界说明》§4
 */

const positiveInt = (max: number) => z.number().int().positive().max(max);

const serverSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3001),
  host: z.string().min(1).default('127.0.0.1'),
  staticDistPath: z.string().min(1).default('../web/dist'),
});

const dbSchema = z.object({
  path: z.string().min(1).default('data/simulator.db'),
  wal: z.boolean().default(true),
});

const dataDirSchema = z.string().min(1).default('data');

const buildsSchema = z.object({
  dir: z.string().min(1).default('data/builds'),
  maxConcurrent: positiveInt(16).default(2),
  timeoutMs: positiveInt(3_600_000).default(300_000),
  quotaMb: positiveInt(1024 * 1024).default(2048),
});

const flashSchema = z.object({
  dir: z.string().min(1).default('data/flash'),
  sessionTimeoutMs: positiveInt(24 * 3_600_000).default(1_800_000),
  reconnectGraceMs: positiveInt(3_600_000).default(60_000),
  cleanupOrphanedAfterHours: positiveInt(720).default(24),
});

const toolsSchema = z.object({
  arduinoCli: z.string().default('arduino-cli'),
  esp32Core: z.string().default('esp32:esp32'),
  esptool: z.string().default('esptool'),
  /** 空串 = 未配置，/api/health/tools 返回 ok:false + reason（02-§1.3） */
  qemuXtensa: z.string().default(''),
  qemuRiscv32: z.string().default(''),
});

const wsSchema = z.object({
  maxConcurrentSessions: positiveInt(64).default(4),
  msgRateLimitPerSec: positiveInt(100_000).default(200),
  maxMsgBytes: positiveInt(16 * 1024 * 1024).default(1_048_576),
  /** 以下四项 ↔《06-边界说明》§7.1.1（WS 心跳与空闲检测，N20） */
  heartbeatIntervalMs: positiveInt(3_600_000).default(15_000),
  heartbeatLossThresholdMs: positiveInt(3_600_000).default(45_000),
  sessionIdleTimeoutMs: positiveInt(24 * 3_600_000).default(60_000),
  sessionMaxLifetimeMs: positiveInt(7 * 24 * 3_600_000).default(1_800_000),
});

const limitsSchema = z.object({
  partsPerProject: positiveInt(100_000).default(120),
  connectionsPerProject: positiveInt(1_000_000).default(300),
  maxFileBytes: positiveInt(1_073_741_824).default(1_048_576),
  filesPerProject: positiveInt(10_000).default(50),
  diagramJsonMaxBytes: positiveInt(1_073_741_824).default(2_097_152),
});

const speedOptionSchema = z.union([
  z.literal(0.25),
  z.literal(0.5),
  z.literal(1),
  z.literal(2),
  z.literal(4),
]);

const simSchema = z.object({
  wasmMemMb: positiveInt(4096).default(256),
  speedOptions: z.array(speedOptionSchema).min(1).default([0.25, 0.5, 1, 2, 4]),
});

const logSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  dir: z.string().min(1).default('logs'),
  rotateMb: positiveInt(1024).default(10),
  rotateKeep: positiveInt(100).default(5),
});

export const appConfigSchema = z.object({
  server: serverSchema.default({}),
  db: dbSchema.default({}),
  dataDir: dataDirSchema,
  builds: buildsSchema.default({}),
  flash: flashSchema.default({}),
  tools: toolsSchema.default({}),
  ws: wsSchema.default({}),
  limits: limitsSchema.default({}),
  sim: simSchema.default({}),
  log: logSchema.default({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
