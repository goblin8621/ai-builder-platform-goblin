import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/index.js';
import type { AuthContextProvider, IncomingRequestLike } from './AuthContextProvider.js';
import type { RequestContext } from './RequestContext.js';

const HEADER_USER_ID = 'x-dev-user-id';
const HEADER_WORKSPACE_ID = 'x-dev-workspace-id';
const HEADER_REQUEST_ID = 'x-request-id';
const HEADER_CONVERSATION_ID = 'x-conversation-id';

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Development-only AuthContextProvider.
 *
 * No real authentication happens here. It always resolves a context using
 * the configured seed userId/workspaceId, but allows overriding them via
 * headers so tests/manual QA can exercise multiple identities/workspaces
 * without a real login system.
 *
 * MUST NOT be wired in production (see server.ts provider selection).
 */
export class DevAuthContextProvider implements AuthContextProvider {
  constructor(private readonly config: AppConfig) {}

  resolve(request: IncomingRequestLike): RequestContext {
    const overrideUserId = this.config.auth.devAllowContextOverrideHeaders
      ? firstHeader(request.headers[HEADER_USER_ID])
      : undefined;
    const overrideWorkspaceId = this.config.auth.devAllowContextOverrideHeaders
      ? firstHeader(request.headers[HEADER_WORKSPACE_ID])
      : undefined;

    const requestId = firstHeader(request.headers[HEADER_REQUEST_ID]) ?? randomUUID();
    const conversationId = firstHeader(request.headers[HEADER_CONVERSATION_ID]) ?? null;

    return {
      userId: overrideUserId ?? this.config.auth.devSeedUserId,
      workspaceId: overrideWorkspaceId ?? this.config.auth.devSeedWorkspaceId,
      requestId,
      conversationId,
    };
  }
}
