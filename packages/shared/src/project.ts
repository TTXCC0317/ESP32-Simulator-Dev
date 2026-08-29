import { z } from 'zod';
import { circuitDocSchema, type CircuitDoc } from './circuit';

/**
 * 工程与示例 REST 模型（《01-总体设计方案》§5.2 REST API、
 * 《03-核心模块详细设计》§2 类型签名 / §2.5 zod schema——单一来源）
 *
 * 约定：projects.board_type 存板卡短名（如 "esp32-devkit-c-v4"），
 * 与 CircuitDoc.boardType（带 "board-" 前缀，01-§7.4.1 N4）不同。
 */

export type EngineId = 'micropython-wasm' | 'qemu-remote';

export const engineIdSchema = z.enum(['micropython-wasm', 'qemu-remote']);

/** 工程源码文件（main.py / sketch / lib/*），path 为相对路径（06-§6 防穿越规范化后） */
export interface ProjectFileEntry {
  path: string;
  content: string;
}

export const projectFileEntrySchema = z.object({
  path: z.string().min(1).max(255),
  content: z.string(),
});

/** 工程元数据（GET /api/projects 列表项；thumbnail 为画布截图 dataURL，04-§8 D3） */
export interface ProjectMeta {
  id: string;
  name: string;
  description: string;
  boardType: string;
  engine: EngineId;
  thumbnail: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 工程完整内容（GET /api/projects/:id / PUT 载荷的基线） */
export interface ProjectDetail extends ProjectMeta {
  diagram: CircuitDoc;
  files: ProjectFileEntry[];
}

/** 新建工程（POST /api/projects）：空白或从内置示例实例化（01-§6.1） */
export interface CreateProjectInput {
  name: string;
  description?: string;
  boardType?: string;
  engine?: EngineId;
  exampleId?: string;
}

/** 更新工程（PUT /api/projects/:id）：给出字段整体替换（files 为全量替换） */
export interface UpdateProjectInput {
  name?: string;
  description?: string;
  boardType?: string;
  engine?: EngineId;
  /** diagram.json 全文（对象形式）；服务端按 catalog + 规模上限校验（06-§3） */
  diagram?: CircuitDoc;
  files?: ProjectFileEntry[];
  thumbnail?: string | null;
}

/** 导出/导入 JSON 包（M3：formatVersion:1，兼容 Wokwi diagram.json 语义） */
export interface ProjectBundle {
  formatVersion: 1;
  project: {
    name: string;
    description: string;
    boardType: string;
    engine: EngineId;
  };
  diagram: CircuitDoc;
  files: ProjectFileEntry[];
}

/** 内置示例列表项（GET /api/examples；manifest 详见 examples 表，列表只回摘要） */
export interface ExampleSummary {
  id: string;
  name: string;
  category: string;
  description: string;
  boardType: string;
  engine: string;
}

// ---- zod schema（§2.5）----

export const projectMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  boardType: z.string().min(1),
  engine: engineIdSchema,
  thumbnail: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const projectDetailSchema = projectMetaSchema.extend({
  diagram: circuitDocSchema,
  files: z.array(projectFileEntrySchema),
});

/** 工程名 ≤100 字符（03-§2.5 约定；06-§3 未单列，随本文档约定） */
export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  boardType: z.string().min(1).optional(),
  engine: engineIdSchema.optional(),
  exampleId: z.string().min(1).optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  boardType: z.string().min(1).optional(),
  engine: engineIdSchema.optional(),
  diagram: circuitDocSchema.optional(),
  files: z.array(projectFileEntrySchema).optional(),
  thumbnail: z.string().nullable().optional(),
});

export const projectBundleSchema = z.object({
  formatVersion: z.literal(1),
  project: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500),
    boardType: z.string().min(1),
    engine: engineIdSchema,
  }),
  diagram: circuitDocSchema,
  files: z.array(projectFileEntrySchema),
});
