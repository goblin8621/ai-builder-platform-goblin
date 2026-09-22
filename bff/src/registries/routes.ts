import type { FastifyInstance } from 'fastify';
import type { BrainClient } from '../brain-client/BrainClient.js';

/**
 * Thin read-only proxy to the Brain Registry endpoints (06번: "BFF: Registry 조회").
 * The Brain owns the actual catalog data — BFF never maintains its own copy.
 */
export function registerRegistryRoutes(app: FastifyInstance, brainClient: BrainClient) {
  app.get('/models', async (request, reply) => {
    const result = await brainClient.models(request.appContext);
    reply.send(result);
  });

  app.get('/tools', async (request, reply) => {
    const result = await brainClient.tools(request.appContext);
    reply.send(result);
  });

  app.get('/capabilities', async (request, reply) => {
    const result = await brainClient.capabilities(request.appContext);
    reply.send(result);
  });
}
