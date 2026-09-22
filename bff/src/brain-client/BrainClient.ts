import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors/index.js';
import type { RequestContext } from '../client-context/RequestContext.js';
import type {
  CapabilitiesResponse,
  ModelsResponse,
  ToolsResponse,
} from '../../../contracts/registries.js';
import type { ApiErrorResponse, ApiErrorCode } from '../../../contracts/common-types.js';
import type { BuilderOutput, BuilderRequestBody } from '../../../contracts/builder.js';
import type { ExecuteRequestBody, RunResult } from '../../../contracts/runtime.js';

export type BrainHealthResponse = {
  status: 'ok';
  service: string;
};

const KNOWN_ERROR_CODES: ApiErrorCode[] = [
  'validation_error',
  'not_found',
  'version_conflict',
  'unauthorized',
  'forbidden',
  'upstream_timeout',
  'upstream_unavailable',
  'internal_error',
];

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    KNOWN_ERROR_CODES.includes((error as { code: ApiErrorCode }).code)
  );
}

/**
 * Thin HTTP client for calling the Python Brain over REST/JSON
 * (05번 문서: BFF <-> Brain은 REST/HTTP+JSON, Streaming은 SSE).
 *
 * Responsibilities kept here so every call site gets them for free:
 * - request timeout
 * - correlation id propagation (x-request-id header)
 * - consistent error mapping to AppError — Brain's own ApiErrorResponse
 *   body (code/message/details) is preserved and rethrown as-is, so a
 *   Builder validation failure reaches the client with its real reason
 *   instead of a generic "upstream unavailable".
 */
export class BrainClient {
  constructor(private readonly config: AppConfig) {}

  async health(context: RequestContext): Promise<BrainHealthResponse> {
    return this.request<BrainHealthResponse>('GET', '/health', context);
  }

  async models(context: RequestContext): Promise<ModelsResponse> {
    return this.request<ModelsResponse>('GET', '/models', context);
  }

  async tools(context: RequestContext): Promise<ToolsResponse> {
    return this.request<ToolsResponse>('GET', '/tools', context);
  }

  async capabilities(context: RequestContext): Promise<CapabilitiesResponse> {
    return this.request<CapabilitiesResponse>('GET', '/capabilities', context);
  }

  async buildSkill(context: RequestContext, body: BuilderRequestBody): Promise<BuilderOutput> {
    return this.request<BuilderOutput>('POST', '/builder/build', context, body);
  }

  async refineSkill(context: RequestContext, body: BuilderRequestBody): Promise<BuilderOutput> {
    return this.request<BuilderOutput>('POST', '/builder/refine', context, body);
  }

  /**
   * `timeoutMsOverride` lets the caller bound this specific call by the
   * Skill's own `runtime.timeoutSec` (08번 Runtime Limit) instead of the
   * generic BFF<->Brain HTTP timeout, since a Skill may legitimately be
   * configured for anywhere up to the platform ceiling (600s).
   */
  async executeSkillRun(
    context: RequestContext,
    body: ExecuteRequestBody,
    timeoutMsOverride?: number,
  ): Promise<RunResult> {
    return this.request<RunResult>('POST', '/runtime/execute', context, body, timeoutMsOverride);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    context: RequestContext,
    body?: unknown,
    timeoutMsOverride?: number,
  ): Promise<T> {
    const url = `${this.config.brain.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutMs = timeoutMsOverride ?? this.config.brain.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-request-id': context.requestId,
          'x-user-id': context.userId,
          'x-workspace-id': context.workspaceId,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const parsed = await response.json().catch(() => null);
        if (isApiErrorResponse(parsed)) {
          throw new AppError(parsed.error.code, parsed.error.message, parsed.error.details);
        }
        throw new AppError(
          'upstream_unavailable',
          `Brain responded with status ${response.status} for ${path}`,
          { status: response.status, path },
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError('upstream_timeout', `Brain request timed out: ${path}`, { path });
      }
      throw new AppError('upstream_unavailable', `Failed to reach Brain: ${path}`, {
        path,
        cause: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
