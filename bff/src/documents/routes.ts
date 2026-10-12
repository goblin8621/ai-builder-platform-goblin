import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { AppError } from '../errors/index.js';
import * as documentService from './document-repository.js';
import { canManageDocumentExport } from '../skill-exports/export-permissions.js';

/**
 * Document API (05번 — Phase 6).
 *
 * Phase 6 scope: plain-text content only (no binary upload / object
 * storage). `workspaceId` always comes from `request.appContext`, never a
 * client-supplied query param — a deliberate deviation from 05번's literal
 * `GET /documents?workspaceId=...` shape, kept consistent with every other
 * list endpoint in this codebase (Phase 3+) to avoid letting a client
 * request another workspace's documents by simply changing a query string.
 */
export function registerDocumentRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/documents', async (request, reply) => {
    const body = request.body as { fileName?: string; mimeType?: string; content?: string } | undefined;
    if (!body?.fileName || !body?.content) {
      throw new AppError('validation_error', 'Request body must include "fileName" and "content"');
    }
    const document = await documentService.createDocument(pool, {
      workspaceId: request.appContext.workspaceId,
      fileName: body.fileName,
      mimeType: body.mimeType ?? 'text/plain',
      content: body.content,
      createdBy: request.appContext.userId,
    });
    reply.code(201).send({ document });
  });

  app.get('/documents', async (request, reply) => {
    const documents = await documentService.listDocuments(pool, request.appContext.workspaceId);
    reply.send({ documents });
  });

  /**
   * Phase 9: allow / revoke exporting a Document. Document "modification" is
   * deliberately limited to this one flag (documents are otherwise
   * create/delete-only). Admin-only: a plain member gets 403, an absent role
   * is treated as member (fail-closed).
   */
  app.patch('/documents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { exportAllowed?: unknown } | undefined;
    if (typeof body?.exportAllowed !== 'boolean') {
      throw new AppError('validation_error', 'Request body must include "exportAllowed" (boolean)');
    }
    if (!canManageDocumentExport(request.appContext)) {
      throw new AppError('forbidden', 'Only a workspace admin can change a document\'s export permission');
    }
    const document = await documentService.setDocumentExportAllowed(
      pool,
      request.appContext.workspaceId,
      id,
      body.exportAllowed,
    );
    if (!document) throw new AppError('not_found', `Document "${id}" not found`);
    reply.send({ document });
  });

  app.delete('/documents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await documentService.deleteDocument(pool, request.appContext.workspaceId, id);
    if (!deleted) throw new AppError('not_found', `Document "${id}" not found`);
    reply.code(204).send();
  });
}
