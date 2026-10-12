/**
 * Phase 9 — Web ↔ BFF drift for the Export UI. `web/lib/types.ts` mirrors the API
 * types without importing contracts (the Web app stays independently deployable),
 * so this test reads the Web type declarations straight from the source file and
 * compares their keys with what the real BFF returns — no hand-copied key lists
 * that could drift themselves.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../bff/src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webTypes = readFileSync(path.join(here, '../../web/lib/types.ts'), 'utf-8');

/** Keys of `export type NAME = { ... };` in web/lib/types.ts (multi-line or single-line declaration). */
function webTypeKeys(name: string): string[] {
  const start = webTypes.indexOf(`export type ${name} = {`);
  if (start === -1) throw new Error(`web/lib/types.ts does not declare ${name}`);
  const firstLine = webTypes.slice(start).split('\n')[0];

  // single-line: `export type X = { a: string; b?: number };` — keys at brace depth 1
  if (/\};\s*$/.test(firstLine)) {
    const keys: string[] = [];
    let depth = 0;
    let token = '';
    for (const ch of firstLine.slice(firstLine.indexOf('{'))) {
      if (ch === '{' || ch === '[' || ch === '(') depth += 1;
      if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
      if (depth === 1 && ch !== '{') token += ch;
      if (depth === 1 && ch === ';') {
        const key = /^\s*(\w+)\??:/.exec(token);
        if (key) keys.push(key[1]);
        token = '';
      }
    }
    const last = /^\s*(\w+)\??:/.exec(token);
    if (last) keys.push(last[1]);
    return keys.sort();
  }

  // multi-line: keys at exactly two-space indentation until the closing `}`
  const keys: string[] = [];
  for (const line of webTypes.slice(start).split('\n').slice(1)) {
    if (line.startsWith('}')) break;
    const match = /^ {2}(\w+)\??:/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys.sort();
}

const keysOf = (value: object) => Object.keys(value).sort();

const built = buildServer();
const app = built.app;
const infra = await (async () => {
  try {
    return (await app.inject({ method: 'GET', url: '/health' })).statusCode === 200;
  } catch {
    return false;
  }
})();
if (!infra) {
  // eslint-disable-next-line no-console
  console.warn('[web-export-types-drift.test.ts] Postgres/Brain not reachable — skipping Web export type drift check.');
}

const NO_CAPS = { webSearch: false, imageGeneration: false, codeExecution: false, dataAnalysis: false, fileAnalysis: false, knowledgeSearch: false, mcp: false };
const spec = (extra: object = {}) => ({
  schemaVersion: '1.0', name: `Drift ${randomUUID().slice(0, 6)}`, description: 'd', skillType: 'workflow',
  inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  instructions: { objective: 'o', rules: [] }, model: { mode: 'user', modelId: null, allowUserOverride: true },
  capabilities: { ...NO_CAPS, fileAnalysis: true }, knowledge: { mode: 'none', documentIds: [] },
  execution: { steps: [{ id: 'parse', name: 'Parse', type: 'tool', refId: 'file-parser' }, { id: 's', name: 'S', type: 'llm' }] },
  runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 4, maxNestedSkillDepth: 0 },
  guardrails: [], usageExamples: [], metadata: { category: 't', tags: [] }, ...extra,
});

async function createSkill(s: object): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/skills', payload: { spec: s } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().skill.id;
}

describe.skipIf(!infra)('Web export types mirror the real BFF responses', () => {
  afterAll(async () => {
    await app.close();
    await built.dbPool.end();
  });

  it('DocumentRecord (GET /documents) includes exportAllowed', async () => {
    const created = await app.inject({ method: 'POST', url: '/documents', payload: { fileName: 'drift.txt', content: 'x' } });
    expect(created.statusCode).toBe(201);
    const list = (await app.inject({ method: 'GET', url: '/documents' })).json().documents as object[];
    expect(keysOf(list[0])).toEqual(webTypeKeys('DocumentRecord'));
    expect(webTypeKeys('DocumentRecord')).toContain('exportAllowed');
  });

  it('target catalog: ExportTargetsResponse / ExportTargetDescriptor / ExportFormatDescriptor', async () => {
    const body = (await app.inject({ method: 'GET', url: '/export/targets' })).json();
    expect(keysOf(body)).toEqual(webTypeKeys('ExportTargetsResponse'));
    expect(keysOf(body.targets[0])).toEqual(webTypeKeys('ExportTargetDescriptor'));
    expect(keysOf(body.targets[0].formats[0])).toEqual(webTypeKeys('ExportFormatDescriptor'));
  });

  it('compatibility: response, result, summary, check, warning and unsupported capability', async () => {
    const id = await createSkill(spec());
    const res = await app.inject({
      method: 'GET',
      url: `/skills/${id}/export/compatibility?version=1&target=claude&format=skill-package`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(keysOf(body)).toEqual(webTypeKeys('ExportCompatibilityResponse'));
    expect(keysOf(body.compatibility)).toEqual(webTypeKeys('CompatibilityResult'));
    expect(keysOf(body.compatibility.summary)).toEqual(webTypeKeys('CompatibilitySummary'));
    expect(keysOf(body.compatibility.checks[0])).toEqual(webTypeKeys('CompatibilityCheck'));
    expect(keysOf(body.compatibility.warnings[0])).toEqual(webTypeKeys('CompatibilityWarning'));
    expect(keysOf(body.compatibility.summary.unsupportedCapabilities[0])).toEqual(webTypeKeys('UnsupportedCapability'));
    expect(keysOf(body.effectiveOptions)).toEqual(webTypeKeys('EffectiveExportOptions'));
    expect(keysOf(body.lock)).toEqual(['dependencies', 'knowledge', 'skill']);
  });

  it('blockers: both secret and knowledge blockers have the ExportBlocker shape', async () => {
    const secret = await createSkill(spec({ description: `use sk-${'Ab3dE5gH7jK9mN1pQ3rS5tU7'}` }));
    const secretBody = (
      await app.inject({ method: 'GET', url: `/skills/${secret}/export/compatibility?version=1&target=generic&format=markdown` })
    ).json();
    expect(keysOf(secretBody.blockers[0])).toEqual(webTypeKeys('ExportBlocker'));

    const doc = (await app.inject({ method: 'POST', url: '/documents', payload: { fileName: 'blk.txt', content: 'x' } })).json().document;
    const kb = await createSkill(spec({ knowledge: { mode: 'selected', documentIds: [doc.id] }, capabilities: { ...NO_CAPS, knowledgeSearch: true, fileAnalysis: true } }));
    const kbBody = (
      await app.inject({ method: 'GET', url: `/skills/${kb}/export/compatibility?version=1&target=claude&format=skill-package&includeKnowledge=true` })
    ).json();
    expect(kbBody.compatibility.level).toBe('blocked');
    expect(keysOf(kbBody.blockers[0])).toEqual(webTypeKeys('ExportBlocker'));
  });

  it('the Web type file declares the same level and status vocabulary as the API', () => {
    expect(webTypes).toMatch(/export type CompatibilityLevel = 'full' \| 'partial' \| 'unsupported' \| 'blocked';/);
    expect(webTypes).toMatch(/export type CompatibilityStatus = 'supported' \| 'partial' \| 'unsupported';/);
  });
});
