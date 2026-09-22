import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { BrainClient } from '../brain-client/BrainClient.js';
import { AppError } from '../errors/index.js';
import * as skillService from './skill-service.js';

/**
 * Skill CRUD + Builder (05번 API 계약 — Phase 3 CRUD + Phase 4 Builder).
 * NOT included here: /skill-runs*, /skills/:id/preview/stream (Phase 5/6 Runtime).
 */
export function registerSkillRoutes(app: FastifyInstance, pool: Pool, brainClient: BrainClient) {
  app.get('/skills', async (request, reply) => {
    const skills = await skillService.listSkills(pool, request.appContext);
    reply.send({ skills });
  });

  app.post('/skills/build', async (request, reply) => {
    const body = request.body as { request?: string } | undefined;
    if (!body?.request) {
      throw new AppError('validation_error', 'Request body must include "request"');
    }
    const result = await skillService.buildSkillFromRequest(pool, brainClient, request.appContext, body.request);
    reply.code(result.action === 'draft' ? 201 : 200).send(result);
  });

  app.post('/skills', async (request, reply) => {
    const body = request.body as { spec?: unknown } | undefined;
    if (!body?.spec) {
      throw new AppError('validation_error', 'Request body must include "spec"');
    }
    const result = await skillService.createSkill(pool, brainClient, request.appContext, body.spec);
    reply.code(201).send(result);
  });

  app.get('/skills/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await skillService.getSkill(pool, request.appContext, id);
    reply.send(result);
  });

  app.patch('/skills/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { expectedVersion?: number; spec?: unknown } | undefined;
    if (typeof body?.expectedVersion !== 'number' || !body?.spec) {
      throw new AppError('validation_error', 'Request body must include "expectedVersion" (number) and "spec"');
    }
    const result = await skillService.updateSkill(
      pool,
      brainClient,
      request.appContext,
      id,
      body.expectedVersion,
      body.spec,
    );
    reply.send(result);
  });

  app.post('/skills/:id/refine', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { expectedVersion?: number; request?: string } | undefined;
    if (typeof body?.expectedVersion !== 'number' || !body?.request) {
      throw new AppError('validation_error', 'Request body must include "expectedVersion" (number) and "request"');
    }
    const result = await skillService.refineSkillFromRequest(
      pool,
      brainClient,
      request.appContext,
      id,
      body.expectedVersion,
      body.request,
    );
    reply.code(200).send(result);
  });

  app.post('/skills/:id/activate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const skill = await skillService.activateSkill(pool, request.appContext, id);
    reply.send({ skill });
  });

  app.post('/skills/:id/duplicate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await skillService.duplicateSkill(pool, brainClient, request.appContext, id);
    reply.code(201).send(result);
  });

  app.delete('/skills/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await skillService.deleteSkill(pool, request.appContext, id);
    reply.code(204).send();
  });

  app.get('/skills/:id/versions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const versions = await skillService.listSkillVersions(pool, request.appContext, id);
    reply.send({ versions });
  });

  app.post('/skills/:id/versions/:version/restore', async (request, reply) => {
    const { id, version } = request.params as { id: string; version: string };
    const result = await skillService.restoreSkillVersion(
      pool,
      brainClient,
      request.appContext,
      id,
      Number(version),
    );
    reply.code(201).send(result);
  });
}
