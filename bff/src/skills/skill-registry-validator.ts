import type { Pool } from 'pg';
import type { RequestContext } from '../client-context/RequestContext.js';
import type { BrainClient } from '../brain-client/BrainClient.js';
import type { CapabilityFlags, SkillSpecV1 } from '../../../contracts/skill-spec.js';
import type { SkillSpecValidationError } from './skill-spec-validator.js';
import { documentIdsExist, getChildSkillIds, skillExists } from './skill-repository.js';

export type RegistrySnapshot = {
  modelIds: Set<string>;
  toolIds: Set<string>;
  capabilities: CapabilityFlags;
};

/**
 * Fetches the current Registry state from Brain. Brain is the single
 * source of truth (06번: "BFF: Registry 조회", data actually lives in
 * brain/app/common/{models,tools,capabilities}) — BFF never keeps its own
 * copy of the catalog.
 */
export async function fetchRegistrySnapshot(
  brainClient: BrainClient,
  context: RequestContext,
): Promise<RegistrySnapshot> {
  const [models, tools, capabilities] = await Promise.all([
    brainClient.models(context),
    brainClient.tools(context),
    brainClient.capabilities(context),
  ]);

  return {
    modelIds: new Set(models.models.map((m) => m.modelId)),
    toolIds: new Set(tools.tools.map((t) => t.toolId)),
    capabilities: capabilities.capabilities,
  };
}

/**
 * 03번 "필수 검증": Registry에 없는 model/tool ID 거부, 서버 비지원
 * Capability 활성화 거부. Purely in-memory — no DB/HTTP calls here, so it
 * stays trivially unit-testable against a hand-built snapshot.
 */
export function validateAgainstRegistrySnapshot(
  spec: SkillSpecV1,
  snapshot: RegistrySnapshot,
): SkillSpecValidationError[] {
  const errors: SkillSpecValidationError[] = [];

  if (spec.model.mode !== 'user' && spec.model.modelId && !snapshot.modelIds.has(spec.model.modelId)) {
    errors.push({
      path: '/model/modelId',
      message: `modelId "${spec.model.modelId}" is not a known Model Registry entry`,
    });
  }

  for (const [flag, enabled] of Object.entries(spec.capabilities) as [keyof CapabilityFlags, boolean][]) {
    if (enabled && !snapshot.capabilities[flag]) {
      errors.push({
        path: `/capabilities/${flag}`,
        message: `capability "${flag}" is not supported by this server`,
      });
    }
  }

  for (const step of spec.execution.steps) {
    if (step.type === 'tool' && (!step.refId || !snapshot.toolIds.has(step.refId))) {
      errors.push({
        path: `/execution/steps/${step.id}/refId`,
        message: `refId "${step.refId ?? ''}" is not a known Tool Registry entry`,
      });
    }
  }

  return errors;
}

export type ReferenceValidationOptions = {
  workspaceId: string;
  /** The skill being updated, if any. Omitted on create — a brand-new skill can't yet be part of any cycle. */
  selfSkillId?: string;
};

/**
 * 03번 "필수 검증": selected Knowledge의 documentIds 존재 확인, 직접/간접
 * Skill dependency cycle 차단. Needs DB access, so it is kept separate from
 * the pure `validateAgainstRegistrySnapshot` above.
 */
export async function validateSkillReferences(
  pool: Pool,
  spec: SkillSpecV1,
  options: ReferenceValidationOptions,
): Promise<SkillSpecValidationError[]> {
  const errors: SkillSpecValidationError[] = [];

  if (spec.knowledge.mode === 'selected' && spec.knowledge.documentIds.length > 0) {
    const existing = await documentIdsExist(pool, options.workspaceId, spec.knowledge.documentIds);
    for (const docId of spec.knowledge.documentIds) {
      if (!existing.has(docId)) {
        errors.push({
          path: '/knowledge/documentIds',
          message: `documentId "${docId}" does not exist in this workspace`,
        });
      }
    }
  }

  for (const step of spec.execution.steps.filter((s) => s.type === 'skill')) {
    const childId = step.refId;
    if (!childId) {
      errors.push({ path: `/execution/steps/${step.id}/refId`, message: 'skill step requires refId' });
      continue;
    }

    if (options.selfSkillId && childId === options.selfSkillId) {
      errors.push({
        path: `/execution/steps/${step.id}/refId`,
        message: `refId "${childId}" creates a direct self-reference cycle`,
      });
      continue;
    }

    const exists = await skillExists(pool, options.workspaceId, childId);
    if (!exists) {
      errors.push({
        path: `/execution/steps/${step.id}/refId`,
        message: `refId "${childId}" is not a known Skill in this workspace`,
      });
      continue;
    }

    if (options.selfSkillId) {
      const cyclePath = await findCycleBackTo(pool, options.workspaceId, childId, options.selfSkillId);
      if (cyclePath) {
        errors.push({
          path: `/execution/steps/${step.id}/refId`,
          message: `refId "${childId}" creates an indirect Skill dependency cycle (${cyclePath.join(' -> ')})`,
        });
      }
    }
  }

  return errors;
}

/**
 * Breadth-first search over `skill`-type step references starting at
 * `startSkillId`, looking for a path back to `targetSkillId` using each
 * visited skill's CURRENT version. Returns the path (for a readable error
 * message) or null when no cycle exists.
 */
async function findCycleBackTo(
  pool: Pool,
  workspaceId: string,
  startSkillId: string,
  targetSkillId: string,
): Promise<string[] | null> {
  const visited = new Set<string>([startSkillId]);
  const queue: string[][] = [[startSkillId]];

  while (queue.length > 0) {
    const path = queue.shift() as string[];
    const current = path[path.length - 1];
    const childIds = await getChildSkillIds(pool, workspaceId, current);

    for (const childId of childIds) {
      if (childId === targetSkillId) {
        return [...path, childId];
      }
      if (!visited.has(childId)) {
        visited.add(childId);
        queue.push([...path, childId]);
      }
    }
  }

  return null;
}
