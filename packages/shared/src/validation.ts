import type { ZodError } from 'zod';
import { circuitDocSchema, type CircuitDoc, type CircuitValidation, type PinRef } from './circuit';
import type { DeviceSpec } from './catalog';

/**
 * 电路文档校验（《03-核心模块详细设计》§2.1 CircuitValidation、§6.1；
 * 连线校验规则见《05-元件清单》§5；规模上限见《06-边界说明》§3）
 */

/** 单机规模上限（《06-边界说明》§3：元件 120 / 连线 300，保存/导入时拒绝） */
export const CIRCUIT_LIMITS = {
  maxParts: 120,
  maxConnections: 300,
  maxDiagramBytes: 2 * 1024 * 1024,
  /** 元件名称（ID）/ 属性值长度上限（06-§3：64 / 256 字符，校验拒绝） */
  partIdMaxChars: 64,
  attrValueMaxChars: 256,
} as const;

/** 规模上限（06-§3）；maxParts/maxConnections 必填，其余字段缺省回落 CIRCUIT_LIMITS */
export type CircuitLimits = {
  maxParts: number;
  maxConnections: number;
  maxDiagramBytes?: number;
  partIdMaxChars?: number;
  attrValueMaxChars?: number;
};

/** 校验上下文：由调用方提供 catalog 视图（web 端为内置 catalog-data，server 端为 parts_catalog 表） */
export interface ValidationContext {
  /** 已知元件/板卡类型集合（含 board- 前缀类型） */
  partTypes: ReadonlySet<string>;
  /** 类型 → 引脚名集合；同名引脚（板卡左右列）只出现一次 */
  pinNames: (type: string) => ReadonlySet<string> | undefined;
  /** M8：类型 → DeviceSpec（I2C/SPI 设备语义）；null = 非总线设备 */
  deviceSpec?: (type: string) => DeviceSpec | null;
  limits?: CircuitLimits;
}

function zodIssuesToMessage(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}

/** 解析 PinRef 为 {partId, pin}；PinRef 形如 "esp:GPIO4"（首个冒号分隔） */
export function parsePinRef(ref: PinRef | string): { partId: string; pin: string } | null {
  const idx = ref.indexOf(':');
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { partId: ref.slice(0, idx), pin: ref.slice(idx + 1) };
}

/**
 * 校验电路文档：结构（zod）→ 规模上限 → 重复 ID → 未知类型 → 引脚引用。
 * 返回全部错误（不短路），与 CircuitValidation.code 一一对应。
 */
export function validateCircuitDoc(raw: unknown, ctx: ValidationContext): CircuitValidation {
  const errors: CircuitValidation['errors'] = [];

  const parsed = circuitDocSchema.safeParse(raw);
  if (!parsed.success) {
    errors.push({ code: 'BAD_JSON', message: zodIssuesToMessage(parsed.error) });
    return { ok: false, errors };
  }
  const doc = parsed.data;
  const limits = { ...CIRCUIT_LIMITS, ...ctx.limits };

  if (doc.parts.length > limits.maxParts) {
    errors.push({
      code: 'OVER_LIMIT',
      message: `元件数 ${doc.parts.length} 超过上限 ${limits.maxParts}`,
    });
  }
  if (doc.connections.length > limits.maxConnections) {
    errors.push({
      code: 'OVER_LIMIT',
      message: `连线数 ${doc.connections.length} 超过上限 ${limits.maxConnections}`,
    });
  }

  const seenIds = new Set<string>();
  for (const p of doc.parts) {
    if (seenIds.has(p.id)) {
      errors.push({ code: 'DUP_PART_ID', message: `元件 ID 重复: ${p.id}`, path: `parts.${p.id}` });
      continue;
    }
    seenIds.add(p.id);
    if (!ctx.partTypes.has(p.type)) {
      errors.push({
        code: 'UNKNOWN_TYPE',
        message: `未知元件类型: ${p.type}（${p.id}）`,
        path: `parts.${p.id}.type`,
      });
    }
    // 名称/属性长度（06-§3：64 / 256 字符）
    if (p.id.length > limits.partIdMaxChars) {
      errors.push({
        code: 'OVER_LIMIT',
        message: `元件 ID 长度 ${p.id.length} 超过 ${limits.partIdMaxChars} 字符上限: ${p.id}`,
        path: `parts.${p.id}.id`,
      });
    }
    for (const [key, value] of Object.entries(p.attrs)) {
      if (typeof value === 'string' && value.length > limits.attrValueMaxChars) {
        errors.push({
          code: 'OVER_LIMIT',
          message: `元件 ${p.id} 属性 ${key} 长度 ${value.length} 超过 ${limits.attrValueMaxChars} 字符上限`,
          path: `parts.${p.id}.attrs.${key}`,
        });
      }
    }
  }

  const pinsByType = new Map<string, ReadonlySet<string>>();
  const pinsOf = (type: string): ReadonlySet<string> | undefined => {
    const cached = pinsByType.get(type);
    if (cached) return cached;
    const s = ctx.pinNames(type);
    if (s) pinsByType.set(type, s);
    return s;
  };

  for (const c of doc.connections) {
    for (const ref of [c.source, c.target] as const) {
      const pr = parsePinRef(ref);
      if (!pr) {
        errors.push({
          code: 'BAD_PINREF',
          message: `PinRef 格式非法: ${ref}（连线 ${c.id}）`,
          path: `connections.${c.id}`,
        });
        continue;
      }
      const part = doc.parts.find((p) => p.id === pr.partId);
      if (!part) {
        errors.push({
          code: 'BAD_PINREF',
          message: `PinRef 指向不存在的元件: ${ref}（连线 ${c.id}）`,
          path: `connections.${c.id}`,
        });
        continue;
      }
      const pins = pinsOf(part.type);
      if (pins && !pins.has(pr.pin)) {
        errors.push({
          code: 'BAD_PINREF',
          message: `元件 ${part.type}(${part.id}) 无引脚 ${pr.pin}（连线 ${c.id}）`,
          path: `connections.${c.id}`,
        });
      }
    }
  }

  // M8：I2C 地址冲突 + SPI CS 冲突扫描（buildDeviceTables 同 addr 覆盖前者，需 UI 提示）
  if (ctx.deviceSpec) {
    const i2cByAddr = new Map<number, { ids: string[]; labels: string[] }>();
    const spiByCs = new Map<number, { ids: string[]; labels: string[] }>();
    for (const p of doc.parts) {
      const spec = ctx.deviceSpec(p.type);
      if (!spec) continue;
      if (spec.kind === 'i2c-device') {
        const entry = i2cByAddr.get(spec.address) ?? { ids: [], labels: [] };
        entry.ids.push(p.id);
        entry.labels.push(`${p.type}(${p.id})`);
        i2cByAddr.set(spec.address, entry);
      } else if (spec.kind === 'spi-device') {
        const entry = spiByCs.get(spec.csGpio) ?? { ids: [], labels: [] };
        entry.ids.push(p.id);
        entry.labels.push(`${p.type}(${p.id})`);
        spiByCs.set(spec.csGpio, entry);
      }
    }
    for (const [addr, { ids, labels }] of i2cByAddr) {
      if (ids.length > 1) {
        errors.push({
          code: 'I2C_ADDR_CONFLICT',
          message: `I2C 地址 0x${addr.toString(16).toUpperCase().padStart(2, '0')} 冲突: ${labels.join(', ')}`,
          partIds: ids,
        });
      }
    }
    for (const [cs, { ids, labels }] of spiByCs) {
      if (ids.length > 1) {
        errors.push({
          code: 'SPI_CS_CONFLICT',
          message: `SPI CS GPIO ${cs} 冲突: ${labels.join(', ')}`,
          partIds: ids,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export type ParseDiagramResult =
  { ok: true; doc: CircuitDoc } | { ok: false; validation: CircuitValidation };

/** diagram.json 文本 → CircuitDoc（结构校验；语义校验需再过 validateCircuitDoc，见 web 端应用流程） */
export function parseDiagram(text: string, ctx?: ValidationContext): ParseDiagramResult {
  if (text.length > CIRCUIT_LIMITS.maxDiagramBytes) {
    return {
      ok: false,
      validation: {
        ok: false,
        errors: [{ code: 'BAD_JSON', message: `diagram.json 超过 2MB 上限` }],
      },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      validation: {
        ok: false,
        errors: [{ code: 'BAD_JSON', message: `JSON 解析失败: ${(e as Error).message}` }],
      },
    };
  }
  if (ctx) {
    const v = validateCircuitDoc(raw, ctx);
    if (!v.ok) return { ok: false, validation: v };
  }
  return { ok: true, doc: raw as CircuitDoc };
}

/** CircuitDoc → diagram.json 文本（2 空格缩进；键序与 CircuitDoc 定义一致） */
export function serializeDiagram(doc: CircuitDoc): string {
  return JSON.stringify(doc, null, 2);
}
