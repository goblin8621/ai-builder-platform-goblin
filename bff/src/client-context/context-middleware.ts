import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthContextProvider } from './AuthContextProvider.js';
import type { RequestContext } from './RequestContext.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Named `appContext` (not `context`) because Fastify already reserves
     * `request.context` for its internal route context.
     */
    appContext: RequestContext;
  }
}

/**
 * Attaches `request.appContext` on every request using the injected
 * AuthContextProvider. Route handlers and domain services must read
 * identity/workspace only from `request.appContext` — never from config
 * or hardcoded values directly.
 */
export function registerContextMiddleware(
  app: FastifyInstance,
  provider: AuthContextProvider,
): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.appContext = provider.resolve({ headers: request.headers });
  });
}
