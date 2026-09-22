import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Ajv, type ErrorObject } from 'ajv';
import type { MappingTable, SkillSpecV1, SkillStep } from '../../../contracts/skill-spec.js';
import { isMappingRef } from './mapping-ref.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, '../../../contracts/skill-spec.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

const ajv = new Ajv({ allErrors: true, strict: false });
const validateStructure = ajv.compile(schema);

export type SkillSpecValidationError = { path: string; message: string };

export type SkillSpecValidationResult =
  | { valid: true; spec: SkillSpecV1 }
  | { valid: false; errors: SkillSpecValidationError[] };

function toValidationErrors(errors: ErrorObject[] | null | undefined): SkillSpecValidationError[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath || '(root)',
    message: e.message ?? 'invalid',
  }));
}

function isValidJsonSchema(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  try {
    // Compiling proves the embedded sub-schema is well-formed
    // (03번: "Input/Output Schema가 유효한 JSON Schema인지 확인").
    new Ajv({ strict: false }).compile(candidate as Record<string, unknown>);
    return true;
  } catch {
    return false;
  }
}

/**
 * Static structural check of one `$ref` string (P5 결정사항 #2): does NOT
 * execute anything, only checks the referenced step id is one that could
 * ever have output at this point in the Skill. Actual resolution (and its
 * own defensive checks) happens only at Run time, in Brain's
 * app/skills/mapping_resolver.py (BFF never executes Steps).
 */
function validateRefString(
  ref: string,
  referenceableStepIds: Set<string>,
  mappingPath: string,
): SkillSpecValidationError[] {
  if (ref === 'input' || ref.startsWith('input.')) return [];
  if (ref.startsWith('steps.')) {
    const rest = ref.slice('steps.'.length);
    const outputIndex = rest.indexOf('.output');
    if (outputIndex === -1) {
      return [{ path: mappingPath, message: `invalid $ref "${ref}" (expected "steps.<stepId>.output[.<path>]")` }];
    }
    const stepId = rest.slice(0, outputIndex);
    if (!referenceableStepIds.has(stepId)) {
      return [
        {
          path: mappingPath,
          message:
            `$ref "${ref}" references step "${stepId}", which does not exist or cannot have executed yet ` +
            'at this point (must appear earlier in execution.steps)',
        },
      ];
    }
    return [];
  }
  return [{ path: mappingPath, message: `invalid $ref "${ref}" (must start with "input" or "steps.")` }];
}

function validateMappingTable(
  mapping: MappingTable,
  referenceableStepIds: Set<string>,
  mappingPath: string,
): SkillSpecValidationError[] {
  const errors: SkillSpecValidationError[] = [];
  for (const [key, value] of Object.entries(mapping)) {
    if (isMappingRef(value)) {
      errors.push(...validateRefString(value.$ref, referenceableStepIds, `${mappingPath}/${key}`));
    }
  }
  return errors;
}

/**
 * Semantic checks that are not expressible as pure JSON Schema constraints.
 * Mirrored exactly in brain/app/skills/validator.py::_run_semantic_checks —
 * keep both in sync; tests/contract/skill-spec fixtures assert they agree.
 */
function runSemanticChecks(spec: SkillSpecV1): SkillSpecValidationError[] {
  const errors: SkillSpecValidationError[] = [];

  if (!isValidJsonSchema(spec.inputSchema)) {
    errors.push({ path: '/inputSchema', message: 'inputSchema must be a valid JSON Schema' });
  }
  if (!isValidJsonSchema(spec.outputSchema)) {
    errors.push({ path: '/outputSchema', message: 'outputSchema must be a valid JSON Schema' });
  }

  const steps: SkillStep[] = spec.execution?.steps ?? [];
  const seenIds = new Set<string>();
  for (const step of steps) {
    if (seenIds.has(step.id)) {
      errors.push({ path: '/execution/steps', message: `duplicate step id: ${step.id}` });
    }
    seenIds.add(step.id);
  }

  const stepIds = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    if (step.onError?.action === 'fallback') {
      const target = step.onError.fallbackStepId;
      if (!target || !stepIds.has(target)) {
        errors.push({
          path: `/execution/steps/${step.id}/onError/fallbackStepId`,
          message: `fallbackStepId "${target ?? ''}" does not reference an existing step`,
        });
      }
    }
  }

  // $ref structural checks (P5 결정사항 #2): a Step's inputMap may only
  // reference a step id that appears EARLIER in execution.steps (it
  // cannot possibly have output yet otherwise); execution.outputMap is
  // resolved after every Step runs, so it may reference ANY step id.
  steps.forEach((step, index) => {
    if (step.inputMap) {
      const referenceable = new Set(steps.slice(0, index).map((s) => s.id));
      errors.push(...validateMappingTable(step.inputMap, referenceable, `/execution/steps/${step.id}/inputMap`));
    }
  });

  if (spec.execution?.outputMap) {
    errors.push(...validateMappingTable(spec.execution.outputMap, stepIds, '/execution/outputMap'));
  }

  return errors;
}

/**
 * Validates a raw (untrusted) value against the canonical SkillSpec
 * contract: structural JSON Schema first, then semantic checks. Never
 * returns a partially-valid spec — either fully valid or a full error list
 * (03번: "수정 시 전체 Spec을 재검증").
 *
 * Registry-dependent checks (model/tool/skill/document existence, server
 * Capability support, Nested Skill cycle/depth) are intentionally NOT done
 * here — the Registry does not exist until Phase 3, and Builder-time
 * Registry validation is Phase 4 (04번 문서). This function only enforces
 * what the Skill Spec can validate about itself.
 */
export function validateSkillSpec(input: unknown): SkillSpecValidationResult {
  const structurallyValid = validateStructure(input);
  if (!structurallyValid) {
    return { valid: false, errors: toValidationErrors(validateStructure.errors) };
  }

  const spec = input as SkillSpecV1;
  const semanticErrors = runSemanticChecks(spec);
  if (semanticErrors.length > 0) {
    return { valid: false, errors: semanticErrors };
  }

  return { valid: true, spec };
}
