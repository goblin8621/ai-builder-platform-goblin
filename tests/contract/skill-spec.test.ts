import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateSkillSpec } from '../../bff/src/skills/skill-spec-validator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures/skill-spec');
const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

describe('SkillSpec contract (JSON Schema + semantic checks)', () => {
  for (const file of fixtureFiles) {
    const shouldBeValid = file.startsWith('valid-');
    const shouldBeInvalid = file.startsWith('invalid-');
    if (!shouldBeValid && !shouldBeInvalid) {
      throw new Error(`Fixture ${file} must be named valid-*.json or invalid-*.json`);
    }

    it(`${file} is ${shouldBeValid ? 'accepted' : 'rejected'}`, () => {
      const spec = JSON.parse(readFileSync(path.join(fixturesDir, file), 'utf-8'));
      const result = validateSkillSpec(spec);

      if (shouldBeValid) {
        expect(result.valid).toBe(true);
      } else {
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.errors.length).toBeGreaterThan(0);
        }
      }
    });
  }

  it('covers at least one valid and one invalid fixture', () => {
    expect(fixtureFiles.some((f) => f.startsWith('valid-'))).toBe(true);
    expect(fixtureFiles.some((f) => f.startsWith('invalid-'))).toBe(true);
  });
});
