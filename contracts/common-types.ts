/**
 * Common contract types shared across BFF, Web, and (mirrored) Python Brain.
 * Source of truth: 02. 데이터 모델 설계 / 05. Skill API 실행 계약 / Phase 1 설계 결정.
 *
 * Python Brain keeps a Pydantic mirror of these types under
 * brain/app/common/context/request_context.py and brain/app/common/errors.
 * Any change here must be reflected there (schemaVersion-style discipline).
 */

/**
 * RequestContext carries identity/isolation data through every request.
 * It is resolved once at the BFF edge by an AuthContextProvider and then
 * passed explicitly through Domain services and into Brain calls.
 *
 * Domain/Skill logic must never read userId/workspaceId from anywhere else
 * (no globals, no hardcoded constants) — always from this object.
 */
export type RequestContext = {
  userId: string;
  workspaceId: string;
  requestId: string;
  /** Optional external client correlation id (e.g. One-Chat conversation). Not required by Skill Core. */
  conversationId?: string | null;
  /**
   * Phase 9: the caller's role in `workspaceId`, resolved by the
   * AuthContextProvider (a real provider reads it from its token claims).
   * Absent means least privilege — treated as 'member', never 'admin'.
   * Used for admin-only actions such as allowing a Document to be exported.
   */
  workspaceRole?: WorkspaceRole;
};

export type WorkspaceRole = 'admin' | 'member';

/**
 * Standard error shape returned by both BFF and Brain APIs.
 */
export type ApiErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'version_conflict'
  | 'unauthorized'
  | 'forbidden'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'internal_error';

export type ApiError = {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
};

export type ApiErrorResponse = {
  error: ApiError;
};

/**
 * Common Streaming Event envelope (05/08 문서 기준).
 * Skill-specific event payloads are added from Phase 5 onward;
 * Phase 1 only fixes the envelope shape.
 */
export type SkillEvent = {
  event: string;
  runId: string;
  skillId: string;
  skillVersion: number;
  stepId?: string;
  timestamp: string;
  data?: unknown;
};
