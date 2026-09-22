import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../../bff/src/config/index.js';
import * as documentRepo from '../../bff/src/documents/document-repository.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.database.url });
const workspaceId = config.auth.devSeedWorkspaceId;
const userId = config.auth.devSeedUserId;

async function isInfraAvailable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

const infraAvailable = await isInfraAvailable();
if (!infraAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[document.test.ts] Postgres not reachable — skipping Document integration tests.');
}

describe.skipIf(!infraAvailable)('Document repository (integration, requires live Postgres)', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('creates a document and chunks its content', async () => {
    const content = 'x'.repeat(2000); // spans 3 chunks at CHUNK_SIZE=800
    const document = await documentRepo.createDocument(pool, {
      workspaceId,
      fileName: 'test.txt',
      mimeType: 'text/plain',
      content,
      createdBy: userId,
    });

    expect(document.status).toBe('ready');
    expect(document.storageKey).toBe(`inline:${document.id}`);

    const corpus = await documentRepo.getKnowledgeCorpus(pool, workspaceId, { mode: 'workspace', documentIds: [] });
    const chunksForDoc = corpus.filter((c) => c.documentId === document.id);
    expect(chunksForDoc).toHaveLength(3);
    expect(chunksForDoc.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);

    await documentRepo.deleteDocument(pool, workspaceId, document.id);
  });

  it('lists documents scoped to the workspace', async () => {
    const document = await documentRepo.createDocument(pool, {
      workspaceId,
      fileName: 'list-test.txt',
      mimeType: 'text/plain',
      content: 'hello',
      createdBy: userId,
    });

    const documents = await documentRepo.listDocuments(pool, workspaceId);
    expect(documents.some((d) => d.id === document.id)).toBe(true);

    await documentRepo.deleteDocument(pool, workspaceId, document.id);
  });

  it('deletes a document and its chunks together', async () => {
    const document = await documentRepo.createDocument(pool, {
      workspaceId,
      fileName: 'delete-test.txt',
      mimeType: 'text/plain',
      content: 'to be deleted',
      createdBy: userId,
    });

    const deleted = await documentRepo.deleteDocument(pool, workspaceId, document.id);
    expect(deleted).toBe(true);

    const documents = await documentRepo.listDocuments(pool, workspaceId);
    expect(documents.some((d) => d.id === document.id)).toBe(false);

    // deleting again should report "not found" (false), not throw.
    const deletedAgain = await documentRepo.deleteDocument(pool, workspaceId, document.id);
    expect(deletedAgain).toBe(false);
  });

  it('getKnowledgeCorpus respects mode=none and mode=selected scoping', async () => {
    const docA = await documentRepo.createDocument(pool, {
      workspaceId,
      fileName: 'a.txt',
      mimeType: 'text/plain',
      content: 'content A',
      createdBy: userId,
    });
    const docB = await documentRepo.createDocument(pool, {
      workspaceId,
      fileName: 'b.txt',
      mimeType: 'text/plain',
      content: 'content B',
      createdBy: userId,
    });

    const none = await documentRepo.getKnowledgeCorpus(pool, workspaceId, { mode: 'none', documentIds: [] });
    expect(none).toEqual([]);

    const selected = await documentRepo.getKnowledgeCorpus(pool, workspaceId, {
      mode: 'selected',
      documentIds: [docA.id],
    });
    expect(selected.every((c) => c.documentId === docA.id)).toBe(true);
    expect(selected.length).toBeGreaterThan(0);

    await documentRepo.deleteDocument(pool, workspaceId, docA.id);
    await documentRepo.deleteDocument(pool, workspaceId, docB.id);
  });
});
