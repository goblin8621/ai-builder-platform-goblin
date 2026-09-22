import { describe, expect, it } from 'vitest';
import {
  validateAgainstRegistrySnapshot,
  type RegistrySnapshot,
} from '../../bff/src/skills/skill-registry-validator.js';
import type { SkillSpecV1 } from '../../contracts/skill-spec.js';

const emptyCapabilities = {
  webSearch: false,
  imageGeneration: false,
  codeExecution: false,
  dataAnalysis: false,
  fileAnalysis: false,
  knowledgeSearch: false,
  mcp: false,
};

function baseSpec(overrides: Partial<SkillSpecV1> = {}): SkillSpecV1 {
  return {
    schemaVersion: '1.0',
    name: 'Test',
    description: 'test',
    skillType: 'prompt',
    inputSchema: {},
    outputSchema: {},
    instructions: { objective: 'x', rules: [] },
    model: { mode: 'user', modelId: null, allowUserOverride: true },
    capabilities: emptyCapabilities,
    knowledge: { mode: 'none', documentIds: [] },
    execution: { steps: [{ id: 's1', name: 'Step', type: 'llm' }] },
    runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 0, maxNestedSkillDepth: 0 },
    guardrails: [],
    usageExamples: [],
    metadata: { category: 'test', tags: [] },
    ...overrides,
  };
}

const snapshot: RegistrySnapshot = {
  modelIds: new Set(['model-001']),
  toolIds: new Set(['file-parser']),
  capabilities: emptyCapabilities,
};

describe('validateAgainstRegistrySnapshot (pure, no DB/HTTP)', () => {
  it('accepts a spec that only uses known registry entries', () => {
    const spec = baseSpec({ model: { mode: 'fixed', modelId: 'model-001', allowUserOverride: false } });
    expect(validateAgainstRegistrySnapshot(spec, snapshot)).toEqual([]);
  });

  it('rejects an unknown modelId', () => {
    const spec = baseSpec({ model: { mode: 'fixed', modelId: 'model-999', allowUserOverride: false } });
    const errors = validateAgainstRegistrySnapshot(spec, snapshot);
    expect(errors.some((e) => e.path === '/model/modelId')).toBe(true);
  });

  it('does not require a known modelId when mode is "user"', () => {
    const spec = baseSpec({ model: { mode: 'user', modelId: null, allowUserOverride: true } });
    expect(validateAgainstRegistrySnapshot(spec, snapshot)).toEqual([]);
  });

  it('rejects an unsupported capability', () => {
    const spec = baseSpec({ capabilities: { ...emptyCapabilities, codeExecution: true } });
    const errors = validateAgainstRegistrySnapshot(spec, snapshot);
    expect(errors.some((e) => e.path === '/capabilities/codeExecution')).toBe(true);
  });

  it('rejects an unknown tool refId', () => {
    const spec = baseSpec({
      skillType: 'tool',
      execution: { steps: [{ id: 's1', name: 'Call tool', type: 'tool', refId: 'does-not-exist' }] },
    });
    const errors = validateAgainstRegistrySnapshot(spec, snapshot);
    expect(errors.some((e) => e.path === '/execution/steps/s1/refId')).toBe(true);
  });

  it('accepts a known tool refId', () => {
    const spec = baseSpec({
      skillType: 'tool',
      execution: { steps: [{ id: 's1', name: 'Call tool', type: 'tool', refId: 'file-parser' }] },
    });
    expect(validateAgainstRegistrySnapshot(spec, snapshot)).toEqual([]);
  });
});
