import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePortableSkill } from '../../bff/src/skill-exports/portable-skill-validator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures/portable-skill');
const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
const schema = JSON.parse(readFileSync(path.join(here, '../../contracts/portable-skill.schema.json'), 'utf-8'));
const read = (file: string) => JSON.parse(readFileSync(path.join(fixturesDir, file), 'utf-8'));

describe('PortableSkill contract (JSON Schema) — same fixtures Brain is tested against', () => {
  for (const file of fixtureFiles) {
    const shouldBeValid = file.startsWith('valid-');
    if (!shouldBeValid && !file.startsWith('invalid-')) {
      throw new Error(`Fixture ${file} must be named valid-*.json or invalid-*.json`);
    }
    it(`${file} is ${shouldBeValid ? 'accepted' : 'rejected'}`, () => {
      const result = validatePortableSkill(read(file));
      expect(result.valid).toBe(shouldBeValid);
      if (!result.valid) expect(result.errors.length).toBeGreaterThan(0);
    });
  }

  it('covers at least one valid and one invalid fixture', () => {
    expect(fixtureFiles.some((f) => f.startsWith('valid-'))).toBe(true);
    expect(fixtureFiles.some((f) => f.startsWith('invalid-'))).toBe(true);
  });

  it('golden fixtures carry no provider names, internal ids, model ids or timestamps', () => {
    for (const file of fixtureFiles.filter((f) => f.startsWith('valid-'))) {
      const text = readFileSync(path.join(fixturesDir, file), 'utf-8');
      expect(text).not.toMatch(/openai|anthropic|claude|gemini|gpt/i);
      expect(text).not.toContain('modelId');
      expect(text).not.toContain('skill-001'); // the internal id the golden was compiled from
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
  });
});

// Hand-copied from contracts/portable-skill.ts (TS types do not exist at runtime): a change to
// either side that the other does not know about fails here — same discipline as web-types-drift.
const PORTABLE_SKILL_TS_KEYS = [
  'formatVersion', 'name', 'description', 'objective', 'instructions', 'guardrails', 'skillType',
  'inputContract', 'outputContract', 'workflow', 'outputMapping', 'dependencies', 'requiredCapabilities',
  'requiredTools', 'knowledge', 'examples', 'runtimeRequirements', 'runtimeLimits', 'source', 'sourceSpec',
];
const PORTABLE_STEP_TS_KEYS = ['id', 'name', 'kind', 'ref', 'input', 'outputKey', 'condition', 'requiresApproval', 'onError'];

describe('PortableSkill TS type mirror matches the schema', () => {
  it('top-level and step keys are identical', () => {
    expect(Object.keys(schema.properties).sort()).toEqual([...PORTABLE_SKILL_TS_KEYS].sort());
    expect(Object.keys(schema.definitions.step.properties).sort()).toEqual([...PORTABLE_STEP_TS_KEYS].sort());
  });

  it('is provider-neutral: no provider vocabulary anywhere in the contract', () => {
    expect(JSON.stringify(schema).replace(/the same inputs always produce the same document/g, '')).not.toMatch(
      /openai|anthropic|claude|gemini/i,
    );
  });
});
