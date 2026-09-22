import type { Pool } from 'pg';
import { AppError } from '../errors/index.js';
import type { RequestContext } from '../client-context/RequestContext.js';
import type { BrainClient } from '../brain-client/BrainClient.js';
import type { SkillSpecV1 } from '../../../contracts/skill-spec.js';
import type { BuilderOutput } from '../../../contracts/builder.js';
import { validateSkillSpec } from './skill-spec-validator.js';
import {
  fetchRegistrySnapshot,
  validateAgainstRegistrySnapshot,
  validateSkillReferences,
} from './skill-registry-validator.js';
import * as repo from './skill-repository.js';
import type { ChangeSource } from './skill-repository.js';

/**
 * Runs the full three-stage validation pipeline (03번 "전체 Spec을 재검증"):
 *   1. structural (JSON Schema)      — Phase 2, skill-spec-validator.ts
 *   2. semantic (step id / fallback) — Phase 2, skill-spec-validator.ts
 *   3. registry (model/tool/capability/skill-cycle/document) — Phase 3, this module
 * Any failure raises a single AppError('validation_error') with every
 * violation collected — never a partial save.
 */
async function validateFullSpec(
  pool: Pool,
  brainClient: BrainClient,
  context: RequestContext,
  rawSpec: unknown,
  options: { selfSkillId?: string },
): Promise<SkillSpecV1> {
  const structural = validateSkillSpec(rawSpec);
  if (!structural.valid) {
    throw new AppError('validation_error', 'Skill Spec failed validation', { errors: structural.errors });
  }

  const snapshot = await fetchRegistrySnapshot(brainClient, context);
  const registryErrors = validateAgainstRegistrySnapshot(structural.spec, snapshot);
  const referenceErrors = await validateSkillReferences(pool, structural.spec, {
    workspaceId: context.workspaceId,
    selfSkillId: options.selfSkillId,
  });

  const errors = [...registryErrors, ...referenceErrors];
  if (errors.length > 0) {
    throw new AppError('validation_error', 'Skill Spec failed validation', { errors });
  }

  return structural.spec;
}

export async function listSkills(pool: Pool, context: RequestContext) {
  return repo.listSkills(pool, context.workspaceId);
}

export async function createSkill(pool: Pool, brainClient: BrainClient, context: RequestContext, rawSpec: unknown) {
  const spec = await validateFullSpec(pool, brainClient, context, rawSpec, {});
  return repo.createSkill(pool, { workspaceId: context.workspaceId, ownerId: context.userId, spec });
}

export async function getSkill(pool: Pool, context: RequestContext, skillId: string) {
  const skill = await repo.getSkill(pool, context.workspaceId, skillId);
  if (!skill) throw new AppError('not_found', `Skill "${skillId}" not found`);
  const version = await repo.getSkillVersion(pool, skillId, skill.currentVersion);
  return { skill, version };
}

/**
 * Shared by manual PATCH and AI-assisted refine: checks the concurrency
 * token, re-validates the full pipeline, and appends a new Version. Only
 * `changeSource`/`changeSummary` differ between the two call sites.
 */
async function checkVersionAndAppend(
  pool: Pool,
  brainClient: BrainClient,
  context: RequestContext,
  skillId: string,
  expectedVersion: number,
  rawSpec: unknown,
  changeSource: ChangeSource,
  changeSummary?: string | null,
) {
  const skill = await repo.getSkill(pool, context.workspaceId, skillId);
  if (!skill) throw new AppError('not_found', `Skill "${skillId}" not found`);

  if (skill.currentVersion !== expectedVersion) {
    throw new AppError(
      'version_conflict',
      `Expected version ${expectedVersion} but current version is ${skill.currentVersion}`,
      { currentVersion: skill.currentVersion },
    );
  }

  const spec = await validateFullSpec(pool, brainClient, context, rawSpec, { selfSkillId: skillId });
  return repo.appendSkillVersion(pool, { skillId, spec, changeSource, changeSummary, createdBy: context.userId });
}

export async function updateSkill(
  pool: Pool,
  brainClient: BrainClient,
  context: RequestContext,
  skillId: string,
  expectedVersion: number,
  rawSpec: unknown,
) {
  return checkVersionAndAppend(pool, brainClient, context, skillId, expectedVersion, rawSpec, 'manual');
}

export async function activateSkill(pool: Pool, context: RequestContext, skillId: string) {
  const skill = await repo.activateSkill(pool, context.workspaceId, skillId);
  if (!skill) throw new AppError('not_found', `Skill "${skillId}" not found`);
  return skill;
}

export async function duplicateSkill(
  pool: Pool,
  brainClient: BrainClient,
  context: RequestContext,
  skillId: string,
) {
  const sourceSpec = await repo.getCurrentSpec(pool, context.workspaceId, skillId);
  if (!sourceSpec) throw new AppError('not_found', `Skill "${skillId}" not found`);

  // Re-validate: the Registry may have changed since the source was saved.
  const spec = await validateFullSpec(pool, brainClient, context, sourceSpec, {});
  return repo.createSkill(pool, { workspaceId: context.workspaceId, ownerId: context.userId, spec });
}

export async function deleteSkill(pool: Pool, context: RequestContext, skillId: string) {
  const deleted = await repo.softDeleteSkill(pool, context.workspaceId, skillId);
  if (!deleted) throw new AppError('not_found', `Skill "${skillId}" not found`);
}

export async function listSkillVersions(pool: Pool, context: RequestContext, skillId: string) {
  const skill = await repo.getSkill(pool, context.workspaceId, skillId);
  if (!skill) throw new AppError('not_found', `Skill "${skillId}" not found`);
  return repo.listSkillVersions(pool, skillId);
}

/**
 * `POST /skills/build` (05번 API): Skill Builder generates a candidate
 * spec from natural language, which is then persisted through the exact
 * same validation+save path as a manually-submitted spec (`createSkill`)
 * — the Builder's output is never trusted directly (04번 9. 완료 기준:
 * "Builder와 Skill Runtime[/저장] 역할이 명확히 분리됨").
 */
export async function buildSkillFromRequest(
  pool: Pool,
  brainClient: BrainClient,
  context: RequestContext,
  request: string,
): Promise<
  | { action: 'clarify'; message: string | null | undefined; missingFields: string[] | null | undefined }
  | { action: 'draft'; skill: repo.SkillRecord; version: repo.SkillVersionRecord }
> {
  const [availableSkills, availableKnowledge] = await Promise.all([
    repo.listSkillSummaries(pool, context.workspaceId),
    repo.listDocumentSummaries(pool, context.workspaceId),
  ]);

  const output: BuilderOutput = await brainClient.buildSkill(context, {
    request,
    currentSpec: null,
    availableSkills,
    availableKnowledge,
    defaults: {},
  });

  if (output.action === 'clarify') {
    return { action: 'clarify', message: output.message, missingFields: output.missingFields };
  }
  if (output.action === 'draft') {
    const { skill, version } = await createSkill(pool, brainClient, context, output.spec);
    return { action: 'draft', skill, version };
  }
  throw new AppError('internal_error', `Skill Builder returned unexpected action "${output.action}" for build`);
}

/**
 * `POST /skills/:id/refine` (05번 API): same `expectedVersion` concurrency
 * check as manual PATCH, but the new spec comes from the Builder and is
 * saved with `change_source = 'ai_refine'` (02번 enum) so Version history
 * distinguishes AI-assisted edits from manual ones.
 */
export async function refineSkillFromRequest(
  pool: Pool,
  brainClient: BrainClient,
  context: RequestContext,
  skillId: string,
  expectedVersion: number,
  request: string,
): Promise<
  | { action: 'clarify'; message: string | null | undefined; missingFields: string[] | null | undefined }
  | { action: 'update'; skill: repo.SkillRecord; version: repo.SkillVersionRecord }
> {
  const skill = await repo.getSkill(pool, context.workspaceId, skillId);
  if (!skill) throw new AppError('not_found', `Skill "${skillId}" not found`);
  if (skill.currentVersion !== expectedVersion) {
    throw new AppError(
      'version_conflict',
      `Expected version ${expectedVersion} but current version is ${skill.currentVersion}`,
      { currentVersion: skill.currentVersion },
    );
  }

  const currentVersionRecord = await repo.getSkillVersion(pool, skillId, skill.currentVersion);
  if (!currentVersionRecord) throw new AppError('not_found', `Version ${skill.currentVersion} not found`);

  const [availableSkills, availableKnowledge] = await Promise.all([
    repo.listSkillSummaries(pool, context.workspaceId),
    repo.listDocumentSummaries(pool, context.workspaceId),
  ]);

  const output: BuilderOutput = await brainClient.refineSkill(context, {
    request,
    currentSpec: currentVersionRecord.spec,
    availableSkills,
    availableKnowledge,
    defaults: {},
  });

  if (output.action === 'clarify') {
    return { action: 'clarify', message: output.message, missingFields: output.missingFields };
  }
  if (output.action === 'update') {
    const changeSummary = output.changeSummary?.join('; ') ?? null;
    const { skill: updatedSkill, version } = await checkVersionAndAppend(
      pool,
      brainClient,
      context,
      skillId,
      expectedVersion,
      output.spec,
      'ai_refine',
      changeSummary,
    );
    return { action: 'update', skill: updatedSkill, version };
  }
  throw new AppError('internal_error', `Skill Builder returned unexpected action "${output.action}" for refine`);
}

export async function restoreSkillVersion(
  pool: Pool,
  brainClient: BrainClient,
  context: RequestContext,
  skillId: string,
  version: number,
) {
  const skill = await repo.getSkill(pool, context.workspaceId, skillId);
  if (!skill) throw new AppError('not_found', `Skill "${skillId}" not found`);

  const target = await repo.getSkillVersion(pool, skillId, version);
  if (!target) throw new AppError('not_found', `Version ${version} not found for skill "${skillId}"`);

  // Re-validate: the Registry may have changed since that old version was saved.
  const spec = await validateFullSpec(pool, brainClient, context, target.spec, { selfSkillId: skillId });
  return repo.appendSkillVersion(pool, {
    skillId,
    spec,
    changeSource: 'restore',
    changeSummary: `Restored from version ${version}`,
    createdBy: context.userId,
  });
}
