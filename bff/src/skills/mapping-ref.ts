import type { MappingRef, MappingValue } from '../../../contracts/skill-spec.js';

/**
 * BFF never executes Steps (that's Brain's `app/skills/mapping_resolver.py`)
 * — it only needs to recognize the `$ref` shape for static semantic
 * validation (bff/src/skills/skill-spec-validator.ts). Keep this predicate
 * identical in spirit to `mapping_resolver.is_mapping_ref` on the Python
 * side: a value is a Mapping Reference ONLY if it is a plain object with
 * exactly one key, `$ref`, whose value is a string.
 */
export function isMappingRef(value: MappingValue): value is MappingRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $ref?: unknown }).$ref === 'string'
  );
}
