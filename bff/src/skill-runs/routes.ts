import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { BrainClient } from '../brain-client/BrainClient.js';
import { AppError } from '../errors/index.js';
import * as skillRunService from './skill-run-service.js';
import type { SkillRunMode } from './skill-run-repository.js';

/**
 * Skill Run (05번 API 계약). `preview/stream` still needs Streaming
 * (explicitly deferred — see README), so it is not included here.
 */
export function registerSkillRunRoutes(app: FastifyInstance, pool: Pool, brainClient: BrainClient) {
  app.post('/skill-runs', async (request, reply) => {
    const body = request.body as { skillId?: string; input?: Record<string, unknown>; mode?: SkillRunMode } | undefined;
    if (!body?.skillId || typeof body.input !== 'object' || body.input === null) {
      throw new AppError('validation_error', 'Request body must include "skillId" and "input"');
    }
    const result = await skillRunService.createAndExecuteRun(
      pool,
      brainClient,
      request.appContext,
      body.skillId,
      body.input,
      body.mode ?? 'run',
    );
    reply.code(201).send(result);
  });

  app.get('/skill-runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await skillRunService.getSkillRun(pool, request.appContext, id);
    reply.send(result);
  });

  app.post('/skill-runs/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await skillRunService.approveRun(pool, brainClient, request.appContext, id);
    reply.send(result);
  });

  app.post('/skill-runs/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await skillRunService.rejectRun(pool, request.appContext, id);
    reply.send(result);
  });

  app.post('/skill-runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await skillRunService.cancelRun(pool, request.appContext, id);
    reply.send(result);
  });
}
