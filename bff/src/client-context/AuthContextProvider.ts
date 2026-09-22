import type { RequestContext } from './RequestContext.js';

/**
 * Minimal request shape AuthContextProvider needs. Kept decoupled from
 * Fastify's request type so a provider implementation (Dev, JWT, OAuth, ...)
 * never depends on the web framework directly.
 */
export type IncomingRequestLike = {
  headers: Record<string, string | string[] | undefined>;
};

/**
 * Resolves the identity/isolation context for an incoming request.
 *
 * This is the ONLY seam where "who is making this request" is decided.
 * Domain/Skill code never decides identity itself — it only receives
 * a RequestContext produced here.
 *
 * Swapping real authentication (JWT/OAuth/SSO) in a future Auth Phase
 * means implementing this interface again and changing the wiring in
 * server.ts — no Domain/Route code should need to change.
 */
export interface AuthContextProvider {
  resolve(request: IncomingRequestLike): RequestContext;
}
