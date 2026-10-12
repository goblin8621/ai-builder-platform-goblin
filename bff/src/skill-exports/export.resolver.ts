import type { Pool } from 'pg';
import { AppError } from '../errors/index.js';
import type { RequestContext } from '../client-context/RequestContext.js';
import type { SkillSpecV1 } from '../../../contracts/skill-spec.js';
import type { ApiErrorCode } from '../../../contracts/common-types.js';
import type { ExportChildSkillPayload, ExportDocumentPayload } from '../../../contracts/export.js';
import * as skillRepo from '../skills/skill-repository.js';
import * as documentRepo from '../documents/document-repository.js';
import { canAccessSkill, documentExportDenial } from './export-permissions.js';

/**
 * Dependency Resolution for Skill Export (Phase 9 확정 결정 #7/#8).
 *
 * At Export start BFF resolves everything the Export is built from and LOCKS
 * it: the requested root Version (never "latest" implicitly), every reachable
 * Child Skill at the Version that is current RIGHT NOW (recorded by number +
 * content hash in the Manifest), and the Knowledge documents. Brain then
 * builds the Package from exactly this snapshot, so an Export is reproducible
 * with respect to {Parent Version, resolved Child Versions, Knowledge
 * Content, Options, Target/Profile} — not merely the Parent Version.
 *
 * Every failure is explicit (never a silently dropped dependency).
 */

const MAX_DEPENDENCY_DEPTH = 16;

export function exportError(
  code: string,
  message: string,
  status: ApiErrorCode = 'validation_error',
  details: Record<string, unknown> = {},
): AppError {
  return new AppError(status, message, { code, ...details });
}

export type ResolvedExportInput = {
  skillId: string;
  version: number;
  spec: SkillSpecV1;
  children: ExportChildSkillPayload[];
  /** No `content` on any document when `knowledgeDenied`. */
  documents: ExportDocumentPayload[];
  /** `report` mode only: at least one document may not be exported (see ResolveOptions). */
  knowledgeDenied: boolean;
};

export type ResolveOptions = {
  /** Load + authorize document CONTENT (only when the Export will embed documents). */
  loadDocumentContent: boolean;
  /**
   * What to do when Include Documents hits a document the caller may not export:
   *  - `throw`  (real Export)  → 403 EXPORT_DOCUMENT_NOT_ALLOWED, the export never runs
   *  - `report` (Compatibility) → keep going WITHOUT any document content and flag
   *    `knowledgeDenied`, so the API can explain "why not" with HTTP 200.
   * Neither mode ever reveals the denied documents' names, ids or content.
   */
  onKnowledgeDenied: 'throw' | 'report';
};

async function resolveChildren(
  pool: Pool,
  context: RequestContext,
  rootSkillId: string,
  rootSpec: SkillSpecV1,
): Promise<ExportChildSkillPayload[]> {
  const resolved = new Map<string, ExportChildSkillPayload>();

  async function visit(spec: SkillSpecV1, stack: string[]): Promise<void> {
    if (stack.length > MAX_DEPENDENCY_DEPTH) {
      throw exportError('EXPORT_DEPENDENCY_TOO_DEEP', `Child Skill nesting exceeds ${MAX_DEPENDENCY_DEPTH} levels`);
    }
    for (const step of spec.execution.steps) {
      if (step.type !== 'skill') continue;
      const childId = step.refId;
      if (!childId) {
        throw exportError('EXPORT_CHILD_UNAVAILABLE', `Step "${step.id}" has no Child Skill reference`, 'validation_error', {
          stepId: step.id,
        });
      }
      if (stack.includes(childId)) {
        throw exportError('EXPORT_DEPENDENCY_CYCLE', `Child Skill dependency cycle detected at step "${step.id}"`, 'validation_error', {
          stepId: step.id,
        });
      }
      if (resolved.has(childId)) continue;

      // getSkill hides soft-deleted rows and rows of other Workspaces, so a
      // deleted / foreign / nonexistent Child all look the same (no leak).
      const child = await skillRepo.getSkill(pool, context.workspaceId, childId);
      if (!child || !canAccessSkill(context, child)) {
        throw exportError(
          'EXPORT_CHILD_UNAVAILABLE',
          `The Child Skill referenced by step "${step.id}" is unavailable (missing, deleted, or not accessible)`,
          'validation_error',
          { stepId: step.id },
        );
      }
      // Lock: the Child Version that is current at this moment.
      const version = await skillRepo.getSkillVersion(pool, childId, child.currentVersion);
      if (!version) {
        throw exportError('EXPORT_CHILD_UNAVAILABLE', `Child Skill version could not be loaded for step "${step.id}"`, 'validation_error', {
          stepId: step.id,
        });
      }
      resolved.set(childId, { skillId: childId, name: child.name, version: version.version, spec: version.spec });
      await visit(version.spec, [...stack, childId]);
    }
  }

  await visit(rootSpec, [rootSkillId]);
  return [...resolved.values()];
}

function selectedDocumentIds(specs: SkillSpecV1[]): string[] {
  const ids = new Set<string>();
  for (const spec of specs) {
    if (spec.knowledge.mode === 'selected') {
      for (const id of spec.knowledge.documentIds) ids.add(id);
    }
  }
  return [...ids].sort();
}

async function resolveDocuments(
  pool: Pool,
  context: RequestContext,
  specs: SkillSpecV1[],
  options: ResolveOptions,
): Promise<{ documents: ExportDocumentPayload[]; denied: boolean }> {
  const ids = selectedDocumentIds(specs);
  if (ids.length === 0) return { documents: [], denied: false };

  const found = await documentRepo.getDocumentsForExport(pool, context.workspaceId, ids, options.loadDocumentContent);
  const byId = new Map(found.map((doc) => [doc.id, doc]));

  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    // An id from another Workspace is indistinguishable from a deleted one.
    throw exportError(
      'EXPORT_DOCUMENT_NOT_FOUND',
      `${missing.length} Knowledge document(s) referenced by the Skill do not exist in this workspace`,
      'not_found',
      { count: missing.length },
    );
  }

  let denied = false;
  if (options.loadDocumentContent) {
    // Include Documents: workspace permission AND document access permission AND export_allowed.
    const reasons = found.map((doc) => documentExportDenial(context, doc)).filter((reason) => reason !== null);
    if (reasons.length > 0) {
      if (options.onKnowledgeDenied === 'throw') {
        // Aggregate reasons only — never a document name, id or content.
        const byReason: Record<string, number> = {};
        for (const reason of reasons) byReason[reason as string] = (byReason[reason as string] ?? 0) + 1;
        throw exportError(
          'EXPORT_DOCUMENT_NOT_ALLOWED',
          'One or more knowledge documents cannot be exported. Ask a workspace admin to allow them, or export without Include Knowledge.',
          'forbidden',
          { reasons: byReason },
        );
      }
      denied = true;
    }
  }

  const withContent = options.loadDocumentContent && !denied;
  return {
    denied,
    documents: ids.map((id) => {
      const doc = byId.get(id)!;
      return {
        documentId: doc.id,
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        ...(withContent ? { content: doc.content ?? '' } : {}),
      };
    }),
  };
}

export async function resolveExportInput(
  pool: Pool,
  context: RequestContext,
  skillId: string,
  version: number,
  options: ResolveOptions,
): Promise<ResolvedExportInput> {
  const skill = await skillRepo.getSkill(pool, context.workspaceId, skillId);
  if (!skill || !canAccessSkill(context, skill)) {
    throw new AppError('not_found', `Skill "${skillId}" not found`, { code: 'EXPORT_SKILL_NOT_FOUND' });
  }
  const versionRecord = await skillRepo.getSkillVersion(pool, skillId, version);
  if (!versionRecord) {
    throw new AppError('not_found', `Version ${version} not found for skill "${skillId}"`, {
      code: 'EXPORT_VERSION_NOT_FOUND',
    });
  }

  const children = await resolveChildren(pool, context, skillId, versionRecord.spec);
  const { documents, denied } = await resolveDocuments(
    pool,
    context,
    [versionRecord.spec, ...children.map((c) => c.spec)],
    options,
  );

  return {
    skillId,
    version: versionRecord.version,
    spec: versionRecord.spec,
    children,
    documents,
    knowledgeDenied: denied,
  };
}
