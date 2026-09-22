import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(here, '../../contracts/openapi/brain-api.yaml');

describe('contracts/openapi/brain-api.yaml', () => {
  it('parses as valid YAML with the expected OpenAPI shape', () => {
    const raw = readFileSync(specPath, 'utf-8');
    const doc = yaml.load(raw) as any;

    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info?.title).toBeTruthy();
    expect(doc.paths).toBeTruthy();
  });

  it('defines the Phase 1 /health endpoint', () => {
    const raw = readFileSync(specPath, 'utf-8');
    const doc = yaml.load(raw) as any;

    expect(doc.paths['/health']).toBeTruthy();
    expect(doc.paths['/health'].get).toBeTruthy();
    expect(doc.paths['/health'].get.responses['200']).toBeTruthy();
  });

  it('defines RequestContext and ApiError schemas matching contracts/common-types.ts', () => {
    const raw = readFileSync(specPath, 'utf-8');
    const doc = yaml.load(raw) as any;

    const schemas = doc.components.schemas;
    expect(schemas.RequestContext.required).toEqual(
      expect.arrayContaining(['userId', 'workspaceId', 'requestId']),
    );
    expect(schemas.ApiError.required).toEqual(expect.arrayContaining(['code', 'message']));
  });
});
