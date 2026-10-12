import type { RequestContext } from '../client-context/RequestContext.js';
import type { SkillRecord } from '../skills/skill-repository.js';
import type { DocumentRecord } from '../documents/document-repository.js';

/**
 * Export permission predicates (10번 §11/§16, Phase 9 확정 결정 #1/#7).
 *
 * Each condition is its own function ON PURPOSE: there is no per-document ACL
 * or per-skill ACL in the data model yet (02번), so "access" currently means
 * "same Workspace" (+ `ready` for documents). When a real ACL arrives it
 * replaces ONE function here — callers and the three-way AND below don't move.
 */

// ---- Skills ------------------------------------------------------------------------------------

/**
 * The caller must be able to access the Skill. Used for the root Skill and
 * for EVERY Child Skill. A soft-deleted Skill is never exportable
 * (`repo.getSkill` already hides deleted rows; this stays as an explicit,
 * independent guard).
 */
export function canAccessSkill(context: RequestContext, skill: SkillRecord): boolean {
  return skill.workspaceId === context.workspaceId && skill.deletedAt === null;
}

// ---- Documents ---------------------------------------------------------------------------------

export function hasWorkspaceAccess(context: RequestContext, document: DocumentRecord): boolean {
  return document.workspaceId === context.workspaceId;
}

/** Document access permission. Today: the document is usable (`ready`). Seam for a future per-document ACL. */
export function hasDocumentAccess(_context: RequestContext, document: DocumentRecord): boolean {
  return document.status === 'ready';
}

export function isExportAllowed(document: DocumentRecord): boolean {
  return document.exportAllowed === true;
}

export type DocumentExportDenial = 'workspace' | 'access' | 'export_not_allowed';

/**
 * Include Documents requires: workspace permission AND document access
 * permission AND export_allowed = true. Returns the first failing reason so
 * the caller can report exactly why — never a silent skip.
 */
export function documentExportDenial(context: RequestContext, document: DocumentRecord): DocumentExportDenial | null {
  if (!hasWorkspaceAccess(context, document)) return 'workspace';
  if (!hasDocumentAccess(context, document)) return 'access';
  if (!isExportAllowed(document)) return 'export_not_allowed';
  return null;
}

/** Only a workspace admin may allow / revoke exporting a Document. Absent role = member (fail-closed). */
export function canManageDocumentExport(context: RequestContext): boolean {
  return context.workspaceRole === 'admin';
}
