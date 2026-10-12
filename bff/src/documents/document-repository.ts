import type { Pool } from 'pg';
import type { SkillSpecV1 } from '../../../contracts/skill-spec.js';

export type DocumentStatus = 'uploaded' | 'processing' | 'ready' | 'failed';

export type DocumentRecord = {
  id: string;
  workspaceId: string;
  fileName: string;
  mimeType: string;
  storageKey: string;
  status: DocumentStatus;
  /** Phase 9: fail-closed (default false). Only a workspace admin can allow a Document to be exported. */
  exportAllowed: boolean;
  createdBy: string;
  createdAt: string;
};

function toDocumentRecord(row: any): DocumentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    storageKey: row.storage_key,
    status: row.status,
    exportAllowed: row.export_allowed,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const CHUNK_SIZE = 800;

function chunkText(content: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    chunks.push(content.slice(i, i + CHUNK_SIZE));
  }
  return chunks.length > 0 ? chunks : [''];
}

export type CreateDocumentInput = {
  workspaceId: string;
  fileName: string;
  mimeType: string;
  content: string;
  createdBy: string;
};

/**
 * Phase 6 scope: plain-TEXT content only, supplied directly in the
 * request body — no binary file upload / object storage (S3-like)
 * integration exists yet. `storage_key` is set to an inline placeholder
 * since the actual text lives in `document_chunks.content`, not a blob
 * store. Chunking is synchronous fixed-size windows (no overlap); no
 * embedding is computed/stored here — app/rag/vectorizer.py (Brain)
 * computes similarity fresh from raw chunk text on every search instead
 * (see README "Mapping" / RAG section for why).
 */
export async function createDocument(pool: Pool, input: CreateDocumentInput): Promise<DocumentRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const docResult = await client.query(
      `INSERT INTO documents (workspace_id, file_name, mime_type, storage_key, status, created_by)
       VALUES ($1, $2, $3, 'inline:pending', 'ready', $4)
       RETURNING *`,
      [input.workspaceId, input.fileName, input.mimeType, input.createdBy],
    );
    const document = toDocumentRecord(docResult.rows[0]);

    await client.query(`UPDATE documents SET storage_key = $1 WHERE id = $2`, [`inline:${document.id}`, document.id]);

    const chunks = chunkText(input.content);
    for (let index = 0; index < chunks.length; index += 1) {
      await client.query(
        `INSERT INTO document_chunks (document_id, chunk_index, content) VALUES ($1, $2, $3)`,
        [document.id, index, chunks[index]],
      );
    }

    await client.query('COMMIT');
    return { ...document, storageKey: `inline:${document.id}` };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listDocuments(pool: Pool, workspaceId: string): Promise<DocumentRecord[]> {
  const result = await pool.query(
    `SELECT * FROM documents WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map(toDocumentRecord);
}

export async function getDocument(pool: Pool, workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
  const result = await pool.query(`SELECT * FROM documents WHERE id = $1 AND workspace_id = $2`, [documentId, workspaceId]);
  return result.rows[0] ? toDocumentRecord(result.rows[0]) : null;
}

/** Admin-only (enforced by the caller, see export-permissions.ts). Returns null if not found in this workspace. */
export async function setDocumentExportAllowed(
  pool: Pool,
  workspaceId: string,
  documentId: string,
  exportAllowed: boolean,
): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `UPDATE documents SET export_allowed = $3 WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [documentId, workspaceId, exportAllowed],
  );
  return result.rows[0] ? toDocumentRecord(result.rows[0]) : null;
}

export type ExportDocumentRecord = DocumentRecord & {
  /** Newline-preserving full text: chunks re-joined in chunk_index order. Only loaded on request. */
  content?: string;
};

/**
 * Loads documents for Skill Export, ALWAYS scoped to `workspaceId` (an id from
 * another Workspace is simply absent from the result — never distinguishable
 * from a missing id). `withContent` joins the stored chunks back into the
 * original text (fixed-size windows without overlap, so concatenation is exact).
 */
export async function getDocumentsForExport(
  pool: Pool,
  workspaceId: string,
  documentIds: string[],
  withContent: boolean,
): Promise<ExportDocumentRecord[]> {
  if (documentIds.length === 0) return [];
  const result = await pool.query(
    withContent
      ? `SELECT d.*, COALESCE((SELECT string_agg(dc.content, '' ORDER BY dc.chunk_index)
                                 FROM document_chunks dc WHERE dc.document_id = d.id), '') AS content
           FROM documents d
          WHERE d.workspace_id = $1 AND d.id = ANY($2::uuid[])
          ORDER BY d.id`
      : `SELECT d.* FROM documents d WHERE d.workspace_id = $1 AND d.id = ANY($2::uuid[]) ORDER BY d.id`,
    [workspaceId, documentIds],
  );
  return result.rows.map((row) => ({
    ...toDocumentRecord(row),
    ...(withContent ? { content: row.content as string } : {}),
  }));
}

export async function deleteDocument(pool: Pool, workspaceId: string, documentId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(`SELECT id FROM documents WHERE id = $1 AND workspace_id = $2`, [
      documentId,
      workspaceId,
    ]);
    if (existing.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(`DELETE FROM document_chunks WHERE document_id = $1`, [documentId]);
    await client.query(`DELETE FROM documents WHERE id = $1`, [documentId]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type KnowledgeChunk = { documentId: string; chunkIndex: number; content: string };

/**
 * Fetches the raw chunk text Brain is allowed to search over for one Run,
 * per the Skill's own `knowledge` policy (03번: `none`/`workspace`/
 * `selected`) — always scoped to `workspaceId` regardless of mode (02번:
 * "실제 검색 범위는 항상 workspaceId + documentIds로 제한").
 */
export async function getKnowledgeCorpus(
  pool: Pool,
  workspaceId: string,
  knowledge: SkillSpecV1['knowledge'],
): Promise<KnowledgeChunk[]> {
  if (knowledge.mode === 'none') return [];

  // ORDER BY is required, not cosmetic: chunk_index must come back in
  // document order (Phase 8 발견 — under concurrent load Postgres does not
  // otherwise guarantee row order, and callers rely on chunkIndex ordering
  // being stable per document).
  const query =
    knowledge.mode === 'selected'
      ? {
          text: `SELECT dc.document_id, dc.chunk_index, dc.content
                   FROM document_chunks dc
                   JOIN documents d ON d.id = dc.document_id
                  WHERE d.workspace_id = $1 AND d.status = 'ready' AND d.id = ANY($2::uuid[])
                  ORDER BY dc.document_id, dc.chunk_index`,
          values: [workspaceId, knowledge.documentIds],
        }
      : {
          text: `SELECT dc.document_id, dc.chunk_index, dc.content
                   FROM document_chunks dc
                   JOIN documents d ON d.id = dc.document_id
                  WHERE d.workspace_id = $1 AND d.status = 'ready'
                  ORDER BY dc.document_id, dc.chunk_index`,
          values: [workspaceId],
        };

  const result = await pool.query(query.text, query.values);
  return result.rows.map((r) => ({ documentId: r.document_id, chunkIndex: r.chunk_index, content: r.content }));
}
