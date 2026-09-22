import { Ajv } from 'ajv';

export type ValidationIssue = { path: string; message: string };

/**
 * Validates an arbitrary value against an arbitrary JSON Schema — used for
 * a Skill's own `inputSchema` (08번: "Input Schema Validation" happens
 * before a Run row is even created). A fresh Ajv instance is used per call
 * since each Skill's inputSchema is a different, spec-supplied schema.
 */
export function validateAgainstJsonSchema(schema: Record<string, unknown>, value: unknown): ValidationIssue[] {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(value);
  if (valid) return [];
  return (validate.errors ?? []).map((e) => ({ path: e.instancePath || '(root)', message: e.message ?? 'invalid' }));
}
