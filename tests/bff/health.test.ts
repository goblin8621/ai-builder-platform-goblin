import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildServer } from '../../bff/src/server.js';

describe('GET /health', () => {
  let app: FastifyInstance;
  let dbPool: Pool;

  beforeAll(() => {
    const built = buildServer();
    app = built.app;
    dbPool = built.dbPool;
  });

  afterAll(async () => {
    await app.close();
    await dbPool.end();
  });

  it('returns a well-formed health payload regardless of dependency availability', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect([200, 503]).toContain(response.statusCode);

    const body = response.json();
    expect(body.service).toBe('bff');
    expect(['ok', 'unavailable']).toContain(body.dependencies.db);
    expect(['ok', 'unavailable']).toContain(body.dependencies.brain);
    expect(typeof body.requestId).toBe('string');

    const bothOk = body.dependencies.db === 'ok' && body.dependencies.brain === 'ok';
    expect(body.status).toBe(bothOk ? 'ok' : 'degraded');
    expect(response.statusCode).toBe(bothOk ? 200 : 503);
  });

  it('reflects the requestId supplied via x-request-id header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-health-test' },
    });

    expect(response.json().requestId).toBe('req-health-test');
  });
});
