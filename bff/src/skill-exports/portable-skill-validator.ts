import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Ajv, type ErrorObject } from 'ajv';

/**
 * PortableSkill contract validator — the SAME contracts/portable-skill.schema.json
 * Brain's Pydantic models are tested against (tests/brain/test_export_compiler.py
 * and tests/contract/portable-skill.test.ts share one fixture set).
 *
 * Used as a contract guard before packaging: if Brain ever emits a skill.json
 * that violates the contract, BFF refuses to hand it to the user.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, '../../../contracts/portable-skill.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

export type PortableSkillValidationError = { path: string; message: string };

export type PortableSkillValidationResult =
  | { valid: true }
  | { valid: false; errors: PortableSkillValidationError[] };

function toErrors(errors: ErrorObject[] | null | undefined): PortableSkillValidationError[] {
  return (errors ?? []).map((e) => ({ path: e.instancePath || '(root)', message: e.message ?? 'invalid' }));
}

export function validatePortableSkill(value: unknown): PortableSkillValidationResult {
  return validate(value) ? { valid: true } : { valid: false, errors: toErrors(validate.errors) };
}
