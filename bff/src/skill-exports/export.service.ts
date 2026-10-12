import type { Pool } from 'pg';
import type { BrainClient } from '../brain-client/BrainClient.js';
import type { RequestContext } from '../client-context/RequestContext.js';
import { AppError } from '../errors/index.js';
import { logger } from '../logging/index.js';
import type {
  ExportBlocker,
  ExportCompatibilityResponse,
  ExportCompileRequestBody,
  ExportCompileResponse,
  ExportFormatDescriptor,
  ExportRequestBody,
} from '../../../contracts/export.js';
import { exportError, resolveExportInput, type ResolvedExportInput } from './export.resolver.js';
import { buildZip } from './package.service.js';
import { validatePortableSkill } from './portable-skill-validator.js';

export type NormalizedExportRequest = {
  version: number;
  target: string;
  format: string;
  includeKnowledge: boolean;
  includeChildSkills: boolean;
  includeSourceSpec: boolean;
  acknowledgeWarnings: boolean;
};

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

/** Export is ALWAYS pinned to an explicit Skill Version — "latest" is never implied. */
function parseVersion(value: unknown): number {
  const version = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw exportError('EXPORT_VERSION_REQUIRED', 'An explicit Skill "version" (positive integer) is required');
  }
  return version;
}

function parseId(value: unknown, code: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw exportError(code, `"${name}" is required`);
  }
  return value.trim();
}

function normalize(input: Record<string, unknown> | undefined, acknowledge: boolean): NormalizedExportRequest {
  return {
    version: parseVersion(input?.version),
    target: parseId(input?.target, 'EXPORT_TARGET_REQUIRED', 'target'),
    format: parseId(input?.format, 'EXPORT_FORMAT_REQUIRED', 'format'),
    includeKnowledge: asBool(input?.includeKnowledge),
    includeChildSkills: asBool(input?.includeChildSkills),
    includeSourceSpec: asBool(input?.includeSourceSpec),
    acknowledgeWarnings: acknowledge && asBool(input?.acknowledgeWarnings),
  };
}

export function normalizeExportBody(body: Partial<ExportRequestBody> | undefined): NormalizedExportRequest {
  return normalize(body as Record<string, unknown> | undefined, true);
}

/** `GET .../export/compatibility?version=N&target=claude&format=skill-package[&includeKnowledge=true]` */
export function normalizeCompatibilityQuery(query: Record<string, unknown>): NormalizedExportRequest {
  return normalize(query, false);
}

/**
 * Brain's catalog is the single source of truth for what exists:
 *   not in the catalog          → EXPORT_TARGET_UNSUPPORTED / EXPORT_FORMAT_UNSUPPORTED
 *   in the catalog, no Adapter  → EXPORT_TARGET_ADAPTER_UNAVAILABLE
 * Checked BEFORE any database work, so an unsupported target never reveals
 * whether a Skill exists.
 */
async function resolveFormat(
  brainClient: BrainClient,
  context: RequestContext,
  request: NormalizedExportRequest,
): Promise<ExportFormatDescriptor> {
  const catalog = await brainClient.exportTargets(context);
  const target = catalog.targets.find((t) => t.id === request.target);
  if (!target) {
    throw exportError('EXPORT_TARGET_UNSUPPORTED', `Export target "${request.target}" is not supported`, 'validation_error', {
      target: request.target,
      supported: catalog.targets.map((t) => t.id),
    });
  }
  const format = target.formats.find((f) => f.id === request.format);
  if (!format) {
    throw exportError(
      'EXPORT_FORMAT_UNSUPPORTED',
      `Target "${target.id}" does not offer format "${request.format}"`,
      'validation_error',
      { target: target.id, format: request.format, supported: target.formats.map((f) => f.id) },
    );
  }
  if (!format.adapterAvailable) {
    throw exportError(
      'EXPORT_TARGET_ADAPTER_UNAVAILABLE',
      `No Export Adapter is registered for target "${target.id}" format "${format.id}"`,
      'validation_error',
      { target: target.id, format: format.id },
    );
  }
  return format;
}

function toCompileBody(
  resolved: ResolvedExportInput,
  request: NormalizedExportRequest,
  dryRun: boolean,
): ExportCompileRequestBody {
  return {
    skillId: resolved.skillId,
    version: resolved.version,
    spec: resolved.spec,
    children: resolved.children,
    documents: resolved.documents,
    options: {
      target: request.target,
      format: request.format,
      // No document content was resolved when access was denied, so analyze as References Only.
      includeKnowledge: request.includeKnowledge && !resolved.knowledgeDenied,
      includeChildSkills: request.includeChildSkills,
      includeSourceSpec: request.includeSourceSpec,
    },
    dryRun,
  };
}

const KNOWLEDGE_BLOCKER: ExportBlocker = {
  code: 'KNOWLEDGE_EXPORT_FORBIDDEN',
  message: 'One or more knowledge documents cannot be exported.',
  findings: [],
};

/**
 * Compatibility explains WHY an export is (not) possible and therefore answers
 * HTTP 200 even when it is blocked: `level: 'blocked'` + `blockers`. A document
 * the caller may not export never turns the whole request into a 403 here —
 * only the real Export does that.
 */
export async function getCompatibility(
  pool: Pool,
  brainClient: BrainClient,
  context: RequestContext,
  skillId: string,
  request: NormalizedExportRequest,
): Promise<ExportCompatibilityResponse> {
  const format = await resolveFormat(brainClient, context, request);
  const resolved = await resolveExportInput(pool, context, skillId, request.version, {
    loadDocumentContent: request.includeKnowledge && format.embedsKnowledge,
    onKnowledgeDenied: 'report',
  });
  const compiled = await brainClient.exportCompile(context, toCompileBody(resolved, request, true));

  const blockers: ExportBlocker[] = [...compiled.blockers];
  let compatibility = compiled.compatibility;
  let effectiveOptions = compiled.effectiveOptions;
  if (resolved.knowledgeDenied) {
    blockers.push(KNOWLEDGE_BLOCKER);
    effectiveOptions = { ...effectiveOptions, includeKnowledge: false };
  }
  if (blockers.length > 0) compatibility = { ...compatibility, level: 'blocked' };

  return {
    compatibility,
    effectiveOptions,
    blockers,
    // The lock snapshot lists document metadata; never return it for a blocked export.
    lock:
      blockers.length === 0 && compiled.manifest
        ? {
            skill: compiled.manifest.skill,
            dependencies: compiled.manifest.dependencies,
            knowledge: compiled.manifest.knowledge,
          }
        : null,
  };
}

export type ExportDownload = {
  filename: string;
  contentType: string;
  body: Uint8Array;
  /** Response metadata. The export TIME lives here (and in the audit log) — never inside the artifact. */
  metadata: { level: string; contentHash: string; exportedAt: string; skillVersion: number };
};

export async function exportSkill(
  pool: Pool,
  brainClient: BrainClient,
  context: RequestContext,
  skillId: string,
  request: NormalizedExportRequest,
): Promise<ExportDownload> {
  const format = await resolveFormat(brainClient, context, request);
  // The real Export re-verifies permissions on the server; whatever the Web UI showed is irrelevant.
  const resolved = await resolveExportInput(pool, context, skillId, request.version, {
    loadDocumentContent: request.includeKnowledge && format.embedsKnowledge,
    onKnowledgeDenied: 'throw',
  });
  const compiled: ExportCompileResponse = await brainClient.exportCompile(context, toCompileBody(resolved, request, false));
  const { compatibility } = compiled;

  // Defense in depth: Brain raises on findings for real exports; never package if it somehow didn't.
  if (compiled.blockers.length > 0 || compiled.files.length === 0 || !compiled.filename || !compiled.contentType || !compiled.contentHash) {
    throw exportError('EXPORT_BLOCKED', 'Export was blocked', 'validation_error', { blockers: compiled.blockers });
  }

  if (format.targetOptimized && compatibility.level === 'unsupported') {
    throw exportError(
      'EXPORT_COMPATIBILITY_UNSUPPORTED',
      'This Skill cannot be reproduced on the selected target (compatibility: unsupported). Target Optimized export is blocked.',
      'validation_error',
      { level: compatibility.level, warnings: compatibility.warnings, manualSteps: compatibility.manualSteps },
    );
  }
  if (compatibility.level !== 'full' && !request.acknowledgeWarnings) {
    throw exportError(
      'EXPORT_ACK_REQUIRED',
      `Compatibility is "${compatibility.level}". Review the warnings and resend with acknowledgeWarnings=true to export anyway.`,
      'validation_error',
      { level: compatibility.level, warnings: compatibility.warnings, manualSteps: compatibility.manualSteps },
    );
  }

  // Contract guard: every skill.json Brain produced must satisfy the PortableSkill schema.
  for (const file of compiled.files) {
    if (file.path === 'skill.json' || file.path.endsWith('/skill.json')) {
      const result = validatePortableSkill(JSON.parse(file.content));
      if (!result.valid) {
        throw new AppError('internal_error', 'Brain produced a PortableSkill that violates the contract', {
          code: 'EXPORT_CONTRACT_VIOLATION',
          path: file.path,
          errors: result.errors,
        });
      }
    }
  }

  const body =
    compiled.packageRoot !== null
      ? buildZip(compiled.packageRoot, compiled.files)
      : new TextEncoder().encode(compiled.files[0].content);

  const exportedAt = new Date().toISOString();
  logger.info('skill exported', {
    requestId: context.requestId,
    skillId,
    skillVersion: request.version,
    target: request.target,
    format: request.format,
    level: compatibility.level,
    contentHash: compiled.contentHash,
    exportedAt,
  });

  return {
    filename: compiled.filename,
    contentType: compiled.contentType,
    body,
    metadata: {
      level: compatibility.level,
      contentHash: compiled.contentHash,
      exportedAt,
      skillVersion: request.version,
    },
  };
}
