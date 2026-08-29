import type {
  BoardDefinition,
  CreateProjectInput,
  ExampleSummary,
  PartDefinition,
  ProjectBundle,
  ProjectDetail,
  ProjectMeta,
  UpdateProjectInput,
} from '@esp32-sim/shared';

/**
 * REST 客户端（01-§5.2）：dev 走 Vite 代理（/api → 127.0.0.1:3001），生产同源。
 * 错误按 01-§5.2.1 envelope 解析为 ApiError（code 供前端精准提示）。
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'NETWORK', '网络错误：无法连接服务端（3001）');
  }
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 非 JSON 响应（如代理 502 HTML）——按状态码处理
  }
  if (!res.ok) {
    const env = (body ?? {}) as ErrorEnvelope;
    throw new ApiError(
      res.status,
      env.error?.code ?? 'UNKNOWN',
      env.error?.message ?? `请求失败（HTTP ${res.status}）`,
    );
  }
  return body as T;
}

const json = (method: string, data: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

export const api = {
  // projects
  listProjects: () => request<ProjectMeta[]>('/api/projects'),
  getProject: (id: string) => request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`),
  createProject: (input: CreateProjectInput) =>
    request<ProjectMeta>('/api/projects', json('POST', input)),
  updateProject: (id: string, patch: UpdateProjectInput) =>
    request<ProjectMeta>(`/api/projects/${encodeURIComponent(id)}`, json('PUT', patch)),
  deleteProject: (id: string) =>
    request<null>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  copyProject: (id: string) =>
    request<ProjectMeta>(`/api/projects/${encodeURIComponent(id)}/copy`, { method: 'POST' }),
  exportProject: (id: string) =>
    request<ProjectBundle>(`/api/projects/${encodeURIComponent(id)}/export`),
  importProject: (bundle: unknown) =>
    request<ProjectMeta>('/api/projects/import', json('POST', bundle)),
  // catalog / examples
  listParts: () => request<PartDefinition[]>('/api/parts'),
  listBoards: () => request<BoardDefinition[]>('/api/boards'),
  listExamples: () => request<ExampleSummary[]>('/api/examples'),
  // builds / engineB（M4）
  submitBuild: (input: { projectId: string; toolchain: 'arduino' | 'esp-idf' }) =>
    request<{ buildId: string }>('/api/build', json('POST', input)),
  getTools: () => request<ToolsStatus>('/api/health/tools'),
};

/** 工具链探测（server /api/health/tools 返回的轻量形状） */
export interface ToolsStatus {
  node: string;
  git: { ok: boolean; version?: string };
  arduinoCli: { ok: boolean; reason?: string; version?: string };
  esptool: { ok: boolean; reason?: string; version?: string };
  qemu: { ok: boolean; reason?: string; version?: string };
}
