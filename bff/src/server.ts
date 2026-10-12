import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config/index.js';
import { logger } from './logging/index.js';
import { AppError, toAppError } from './errors/index.js';
import type { ApiErrorResponse } from '../../contracts/common-types.js';
import { createDbPool } from './db/index.js';
import { registerHealthRoutes } from './health/routes.js';
import { BrainClient } from './brain-client/BrainClient.js';
import { registerContextMiddleware } from './client-context/context-middleware.js';
import { selectAuthProvider } from './client-context/select-auth-provider.js';
import type { AuthContextProvider } from './client-context/AuthContextProvider.js';
import { registerSkillRoutes } from './skills/routes.js';
import { registerRegistryRoutes } from './registries/routes.js';
import { registerSkillRunRoutes } from './skill-runs/routes.js';
import { registerDocumentRoutes } from './documents/routes.js';
import { EXPORT_EXPOSED_HEADERS, registerExportRoutes } from './skill-exports/export.routes.js';

export function buildServer() {
  const config = loadConfig();
  const app = Fastify({ logger: false });

  // Phase 7: web/ calls the BFF directly from the browser.
  void app.register(cors, { origin: config.webOrigins, exposedHeaders: EXPORT_EXPOSED_HEADERS });

  // Auth provider selection is the ONLY place identity resolution is wired.
  // A future real-auth Phase adds e.g. JwtAuthContextProvider here and
  // swaps this line — no route/domain code changes. Throws in production
  // rather than silently wiring DevAuthContextProvider (see
  // select-auth-provider.ts — mirrors Brain's ModelClient selection gate).
  const authProvider: AuthContextProvider = selectAuthProvider(config);
  registerContextMiddleware(app, authProvider);

  const dbPool = createDbPool(config);
  const brainClient = new BrainClient(config);

  registerHealthRoutes(app, dbPool, brainClient);
  registerSkillRoutes(app, dbPool, brainClient);
  registerRegistryRoutes(app, brainClient);
  registerSkillRunRoutes(app, dbPool, brainClient);
  registerDocumentRoutes(app, dbPool);
  registerExportRoutes(app, dbPool, brainClient);

  app.setErrorHandler((err, request, reply) => {
    const appError = toAppError(err);
    logger.error(appError.message, {
      requestId: request.appContext?.requestId,
      code: appError.code,
    });
    const body: ApiErrorResponse = { error: appError.toApiError(request.appContext?.requestId) };
    reply.code(appError.httpStatus).send(body);
  });

  return { app, config, dbPool };
}

async function main() {
  const { app, config } = buildServer();
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info(`BFF listening on port ${config.port}`, { mode: config.mode });
  } catch (err) {
    logger.error('Failed to start BFF', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  void main();
}

export { AppError };
