/**
 * REST 业务错误（01-§5.2.1 错误码枚举）：
 * 路由抛出 → buildApp 统一 setErrorHandler 渲染 envelope（含 traceId）。
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (msg: string) => new HttpError(400, 'BAD_REQUEST', msg);
export const pathTraversal = (msg: string) => new HttpError(400, 'PATH_TRAVERSAL', msg);
export const notFound = (msg: string) => new HttpError(404, 'NOT_FOUND', msg);
export const validationFailed = (msg: string) => new HttpError(422, 'VALIDATION_FAILED', msg);
export const overLimit = (msg: string) => new HttpError(413, 'OVER_LIMIT', msg);
