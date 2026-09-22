import type { ApiError, ApiErrorCode } from '../../../contracts/common-types.js';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  validation_error: 400,
  not_found: 404,
  version_conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  upstream_timeout: 504,
  upstream_unavailable: 502,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return STATUS_BY_CODE[this.code];
  }

  toApiError(requestId?: string): ApiError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      requestId,
    };
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : 'Unexpected error';
  return new AppError('internal_error', message);
}
