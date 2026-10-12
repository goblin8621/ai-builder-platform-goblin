import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { BrainClient } from '../brain-client/BrainClient.js';
import type { ExportRequestBody } from '../../../contracts/export.js';
import {
  exportSkill,
  getCompatibility,
  normalizeCompatibilityQuery,
  normalizeExportBody,
} from './export.service.js';
import { contentDisposition } from './package.service.js';

/** Response headers a browser client needs to read (see CORS exposedHeaders in server.ts). */
export const EXPORT_EXPOSED_HEADERS = [
  'content-disposition',
  'x-export-compatibility',
  'x-export-content-hash',
  'x-export-skill-version',
  'x-exported-at',
];

/**
 * Skill Export (10번 §13). Brain compiles; BFF resolves permissions/versions
 * and packages. Routes are thin on purpose.
 */
export function registerExportRoutes(app: FastifyInstance, pool: Pool, brainClient: BrainClient) {
  app.get('/export/targets', async (request, reply) => {
    reply.send(await brainClient.exportTargets(request.appContext));
  });

  app.get('/skills/:id/export/compatibility', async (request, reply) => {
    const { id } = request.params as { id: string };
    const normalized = normalizeCompatibilityQuery(request.query as Record<string, unknown>);
    reply.send(await getCompatibility(pool, brainClient, request.appContext, id, normalized));
  });

  app.post('/skills/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const normalized = normalizeExportBody(request.body as Partial<ExportRequestBody> | undefined);
    const result = await exportSkill(pool, brainClient, request.appContext, id, normalized);

    reply
      .header('content-type', result.contentType)
      .header('content-disposition', contentDisposition(result.filename))
      .header('cache-control', 'no-store')
      .header('x-export-compatibility', result.metadata.level)
      .header('x-export-content-hash', result.metadata.contentHash)
      .header('x-export-skill-version', String(result.metadata.skillVersion))
      .header('x-exported-at', result.metadata.exportedAt)
      .send(Buffer.from(result.body));
  });
}
