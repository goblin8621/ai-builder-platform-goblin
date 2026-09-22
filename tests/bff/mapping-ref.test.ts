import { describe, expect, it } from 'vitest';
import { isMappingRef } from '../../bff/src/skills/mapping-ref.js';

describe('isMappingRef (static-validation predicate, mirrors Python mapping_resolver.is_mapping_ref)', () => {
  it('matches the exact {$ref: string} object shape', () => {
    expect(isMappingRef({ $ref: 'input.text' })).toBe(true);
  });

  it('rejects a plain string even if it looks like a reference', () => {
    expect(isMappingRef('input.text')).toBe(false);
    expect(isMappingRef('steps.x.output.y')).toBe(false);
  });

  it('rejects an object with extra keys beyond $ref', () => {
    expect(isMappingRef({ $ref: 'input.text', extra: 1 } as any)).toBe(false);
  });

  it('rejects a non-string $ref value', () => {
    expect(isMappingRef({ $ref: 123 } as any)).toBe(false);
  });

  it('rejects null, arrays, and other primitives', () => {
    expect(isMappingRef(null)).toBe(false);
    expect(isMappingRef(['$ref'] as any)).toBe(false);
    expect(isMappingRef(42)).toBe(false);
  });
});
