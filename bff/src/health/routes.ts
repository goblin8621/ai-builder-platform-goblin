import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { checkDb } from '../db/index.js';
import { BrainClient } from '../brain-client/BrainClient.js';

export function registerHealthRoutes(app: FastifyInstance, pool: Pool, brainClient: BrainClient) {
  app.get('/health', async (request, reply) => {
    const dbOk = await checkDb(pool);

    let brainOk = false;
    try {
      const brainHealth = await brainClient.health(request.appContext);
      brainOk = brainHealth.status === 'ok';
    } catch {
      brainOk = false;
    }

    const status = dbOk && brainOk ? 'ok' : 'degraded';
    reply.code(status === 'ok' ? 200 : 503).send({
      status,
      service: 'bff',
      dependencies: {
        db: dbOk ? 'ok' : 'unavailable',
        brain: brainOk ? 'ok' : 'unavailable',
      },
      requestId: request.appContext.requestId,
    });
  });
}
