/**
 * Phase 9 — Skill Export (BFF + Brain integration, real Postgres + Brain).
 * Everything goes through the real HTTP surface via Fastify `inject`, so
 * status codes, Content-Type and headers are asserted for real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { buildServer } from '../../bff/src/server.js';
import * as documentRepo from '../../bff/src/documents/document-repository.js';
import type { SkillSpecV1 } from '../../contracts/skill-spec.js';

const built = buildServer();
const app: FastifyInstance = built.app;
const pool: Pool = built.dbPool;
const config = built.config;
const SEED_WS = config.auth.devSeedWorkspaceId;
const SEED_USER = config.auth.devSeedUserId;

const infraAvailable = await (async () => {
  try {
    const health = await app.inject({ method: 'GET', url: '/health' });
    return health.statusCode === 200;
  } catch {
    return false;
  }
})();
if (!infraAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[skill-export.test.ts] Postgres/Brain not reachable — skipping Skill Export integration tests.');
}

// Target + format pairs of the public API.
const F = {
  markdown: { target: 'generic', format: 'markdown' },
  package: { target: 'generic', format: 'portable-package' },
  raw: { target: 'generic', format: 'raw-spec' },
  claude: { target: 'claude', format: 'skill-package' },
} as const;

const OPENAI_STYLE = 'sk-' + 'Ab3dE5gH7jK9mN1pQ3rS5tU7';
const NO_CAPS = {
  webSearch: false, imageGeneration: false, codeExecution: false, dataAnalysis: false,
  fileAnalysis: false, knowledgeSearch: false, mcp: false,
};

function unique(label: string): string {
  return `${label} ${randomUUID().slice(0, 8)}`;
}

function promptSpec(name = unique('Export Prompt'), objective = 'Translate the input text into English.'): SkillSpecV1 {
  return {
    schemaVersion: '1.0',
    name,
    description: 'export test skill',
    skillType: 'prompt',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['translatedText'], properties: { translatedText: { type: 'string' } } },
    instructions: { objective, rules: ['No explanations.'] },
    model: { mode: 'user', modelId: null, allowUserOverride: true },
    capabilities: { ...NO_CAPS },
    knowledge: { mode: 'none', documentIds: [] },
    execution: { steps: [{ id: 'translate', name: 'Translate', type: 'llm' }] },
    runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 0, maxNestedSkillDepth: 0 },
    guardrails: [],
    usageExamples: [{ input: { text: 'hello' } }],
    metadata: { category: 'test', tags: [] },
  };
}

function workflowSpec(name = unique('Export Workflow')): SkillSpecV1 {
  return {
    ...promptSpec(name),
    skillType: 'workflow',
    capabilities: { ...NO_CAPS, fileAnalysis: true },
    execution: {
      steps: [
        { id: 'parse', name: 'Parse', type: 'tool', refId: 'file-parser', onError: { action: 'retry', retryCount: 2 } },
        { id: 'summarize', name: 'Summarize', type: 'llm' },
      ],
    },
    runtime: { timeoutSec: 60, retryCount: 1, maxToolCalls: 4, maxNestedSkillDepth: 0 },
  };
}

function compositeSpec(name: string, childId: string): SkillSpecV1 {
  return {
    ...promptSpec(name),
    skillType: 'composite',
    execution: {
      steps: [
        { id: 'delegate', name: 'Delegate', type: 'skill', refId: childId, inputMap: { text: { $ref: 'input.text' } } },
      ],
    },
    runtime: { timeoutSec: 60, retryCount: 1, maxToolCalls: 0, maxNestedSkillDepth: 2 },
  };
}

function knowledgeSpec(name: string, documentIds: string[], mode: 'selected' | 'workspace' = 'selected'): SkillSpecV1 {
  return {
    ...promptSpec(name),
    skillType: 'knowledge',
    capabilities: { ...NO_CAPS, knowledgeSearch: true },
    knowledge: { mode, documentIds },
    execution: {
      steps: [
        { id: 'search', name: 'Search', type: 'knowledge', inputMap: { query: { $ref: 'input.text' } } },
        { id: 'answer', name: 'Answer', type: 'llm' },
      ],
    },
  };
}

async function createSkill(spec: SkillSpecV1): Promise<{ id: string; version: number }> {
  const res = await app.inject({ method: 'POST', url: '/skills', payload: { spec } });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return { id: body.skill.id, version: body.version.version };
}

function postExport(id: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: `/skills/${id}/export`, payload, headers });
}

function getCompat(id: string, query: Record<string, string | number | boolean>, headers: Record<string, string> = {}) {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  return app.inject({ method: 'GET', url: `/skills/${id}/export/compatibility?${qs}`, headers });
}

function unzipText(res: LightMyRequestResponse): Record<string, string> {
  const entries = unzipSync(new Uint8Array(res.rawPayload));
  return Object.fromEntries(Object.entries(entries).map(([path, bytes]) => [path, strFromU8(bytes)]));
}

const errorOf = (res: LightMyRequestResponse) => res.json().error as { code: string; message: string; details: any };
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

async function createWorkspace(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'Export test workspace')`, [id]);
  return id;
}

async function createDoc(fileName: string, content: string, exportAllowed = false) {
  const doc = await documentRepo.createDocument(pool, {
    workspaceId: SEED_WS, fileName, mimeType: 'text/plain', content, createdBy: SEED_USER,
  });
  if (exportAllowed) await pool.query(`UPDATE documents SET export_allowed = true WHERE id = $1`, [doc.id]);
  return doc;
}

describe.skipIf(!infraAvailable)('Skill Export API (integration)', () => {
  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // ---------------- request validation ----------------

  describe('request validation', () => {
    it('requires an explicit version (never "latest" implicitly)', async () => {
      const { id } = await createSkill(promptSpec());
      for (const payload of [{ ...F.markdown }, { ...F.markdown, version: 'latest' }, { ...F.markdown, version: 0 }, { ...F.markdown, version: 1.5 }]) {
        const res = await postExport(id, payload);
        expect(res.statusCode).toBe(400);
        expect(errorOf(res).details.code).toBe('EXPORT_VERSION_REQUIRED');
      }
      const compat = await getCompat(id, { ...F.markdown });
      expect(compat.statusCode).toBe(400);
      expect(errorOf(compat).details.code).toBe('EXPORT_VERSION_REQUIRED');
    });

    it('requires both target and format', async () => {
      const { id } = await createSkill(promptSpec());
      expect(errorOf(await postExport(id, { version: 1, format: 'markdown' })).details.code).toBe('EXPORT_TARGET_REQUIRED');
      expect(errorOf(await postExport(id, { version: 1, target: 'generic' })).details.code).toBe('EXPORT_FORMAT_REQUIRED');
      expect(errorOf(await getCompat(id, { version: 1, format: 'markdown' })).details.code).toBe('EXPORT_TARGET_REQUIRED');
      expect(errorOf(await getCompat(id, { version: 1, target: 'claude' })).details.code).toBe('EXPORT_FORMAT_REQUIRED');
    });

    it('an unsupported target is EXPORT_TARGET_UNSUPPORTED and an unoffered format is EXPORT_FORMAT_UNSUPPORTED', async () => {
      const { id } = await createSkill(promptSpec());
      const unknown = await postExport(id, { version: 1, target: 'no-such-runtime', format: 'x' });
      expect(unknown.statusCode).toBe(400);
      expect(errorOf(unknown).details).toMatchObject({ code: 'EXPORT_TARGET_UNSUPPORTED', target: 'no-such-runtime' });
      expect(errorOf(unknown).details.supported).toEqual(expect.arrayContaining(['claude', 'generic']));

      const badFormat = await postExport(id, { version: 1, target: 'claude', format: 'markdown' });
      expect(errorOf(badFormat).details).toMatchObject({ code: 'EXPORT_FORMAT_UNSUPPORTED', supported: ['skill-package'] });
      const compat = await getCompat(id, { version: 1, target: 'no-such-runtime', format: 'x' });
      expect(errorOf(compat).details.code).toBe('EXPORT_TARGET_UNSUPPORTED');
    });

    it('validates the target BEFORE touching the Skill (no existence leak)', async () => {
      const res = await postExport(randomUUID(), { version: 1, target: 'nope', format: 'x' });
      expect(res.statusCode).toBe(400); // not 404: an unsupported target never reveals whether the Skill exists
      expect(errorOf(res).details.code).toBe('EXPORT_TARGET_UNSUPPORTED');
    });
  });

  // ---------------- formats / content types ----------------

  describe('formats', () => {
    it('Prompt Skill → Generic Markdown (text/markdown, attachment, full)', async () => {
      const name = unique('Markdown Skill');
      const { id } = await createSkill(promptSpec(name));
      const res = await postExport(id, { version: 1, ...F.markdown });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename=".+-v1\.md"; filename\*=UTF-8''/);
      expect(res.headers['x-export-compatibility']).toBe('full');
      expect(res.headers['x-export-skill-version']).toBe('1');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain(`# ${name}`);
      expect(res.body).toContain('## Instructions');
    });

    it('Raw SkillSpec → application/json containing exactly the stored spec', async () => {
      const spec = promptSpec();
      const { id } = await createSkill(spec);
      const res = await postExport(id, { version: 1, ...F.raw });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['content-disposition']).toContain('.skillspec.json');
      expect(res.json()).toEqual(spec);
    });

    it('Prompt Skill → Portable Package (application/zip with the documented layout)', async () => {
      const name = unique('Package Skill');
      const { id } = await createSkill(promptSpec(name));
      const res = await postExport(id, { version: 1, ...F.package });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toMatch(/filename=".+-v1\.zip"/);
      expect(res.headers['x-export-compatibility']).toBe('full');
      expect(res.headers['x-export-content-hash']).toMatch(/^[0-9a-f]{64}$/);

      const files = unzipText(res);
      const paths = Object.keys(files);
      const root = paths[0].split('/')[0];
      expect(paths.sort()).toEqual([`${root}/SKILL.md`, `${root}/manifest.json`, `${root}/skill.json`]);
      expect(JSON.parse(files[`${root}/skill.json`]).name).toBe(name);
      const manifest = JSON.parse(files[`${root}/manifest.json`]);
      expect(manifest.skill).toMatchObject({ displayName: name, version: 1, skillType: 'prompt', archivePath: root });
      expect(manifest.files.map((f: any) => f.path).sort()).toEqual(['SKILL.md', 'skill.json']);
    });

    it('GET /export/targets proxies the target catalog', async () => {
      const res = await app.inject({ method: 'GET', url: '/export/targets' });
      expect(res.statusCode).toBe(200);
      const targets = Object.fromEntries(res.json().targets.map((t: any) => [t.id, t]));
      expect(Object.keys(targets).sort()).toEqual(['claude', 'generic']);
      expect(targets.generic.formats.map((f: any) => f.id)).toEqual(['portable-package', 'markdown', 'raw-spec']);
      expect(targets.claude.formats).toHaveLength(1);
      expect(targets.claude.formats[0]).toMatchObject({ id: 'skill-package', targetOptimized: true, embedsKnowledge: true, adapterAvailable: true });
    });

    it('exposes the download headers to browsers (CORS expose-headers)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/export/targets',
        headers: { origin: config.webOrigins[0] },
      });
      expect(res.headers['access-control-expose-headers']).toContain('content-disposition');
      expect(res.headers['access-control-expose-headers']).toContain('x-export-compatibility');
    });

    it('Prompt Skill → Claude Skill (application/zip, SKILL.md with valid frontmatter)', async () => {
      const name = unique('Claude Skill');
      const { id } = await createSkill(promptSpec(name));
      const res = await postExport(id, { version: 1, ...F.claude });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['x-export-compatibility']).toBe('full');
      const files = unzipText(res);
      const root = Object.keys(files)[0].split('/')[0];
      expect(root).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
      expect(Object.keys(files).sort()).toEqual([`${root}/SKILL.md`, `${root}/manifest.json`, `${root}/skill.json`]);
      expect(files[`${root}/SKILL.md`]).toMatch(/^---\nname: [a-z0-9-]+\n/);
    });
  });

  // ---------------- version pinning ----------------

  describe('version pinning', () => {
    it('exports exactly the requested Version, even after newer Versions exist', async () => {
      const { id } = await createSkill(promptSpec(unique('Pinned'), 'Version one objective.'));
      const patch = await app.inject({
        method: 'PATCH',
        url: `/skills/${id}`,
        payload: { expectedVersion: 1, spec: promptSpec(unique('Pinned'), 'Version two objective.') },
      });
      expect(patch.statusCode, patch.body).toBe(200);

      const v1 = await postExport(id, { version: 1, ...F.markdown });
      const v2 = await postExport(id, { version: 2, ...F.markdown });
      expect(v1.body).toContain('Version one objective.');
      expect(v1.body).not.toContain('Version two objective.');
      expect(v2.body).toContain('Version two objective.');
      expect(v1.headers['x-export-skill-version']).toBe('1');
      expect(v2.headers['x-export-skill-version']).toBe('2');

      const compat = await getCompat(id, { version: 1, ...F.package });
      expect(compat.json().lock.skill.version).toBe(1);
    });

    it('a Version that does not exist is 404 (no silent fallback to latest)', async () => {
      const { id } = await createSkill(promptSpec());
      const res = await postExport(id, { version: 99, ...F.markdown });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).details.code).toBe('EXPORT_VERSION_NOT_FOUND');
    });
  });

  // ---------------- compatibility API ----------------

  describe('compatibility', () => {
    it('returns lowercase canonical levels and the locked snapshot', async () => {
      const { id } = await createSkill(promptSpec());
      const res = await getCompat(id, { version: 1, ...F.markdown });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.compatibility.level).toBe('full');
      expect(body.compatibility).toMatchObject({ target: 'generic', format: 'markdown' });
      expect(body.blockers).toEqual([]);
      expect(body.effectiveOptions).toEqual({ includeKnowledge: false, includeChildSkills: false, includeSourceSpec: false });
      expect(body.lock.skill).toMatchObject({ version: 1 });
      expect(body.lock.skill.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('explains PARTIAL with reasons and manual steps', async () => {
      const { id } = await createSkill(workflowSpec());
      const body = (await getCompat(id, { version: 1, ...F.markdown })).json();
      expect(body.compatibility.level).toBe('partial');
      expect(body.compatibility.checks.find((c: any) => c.id === 'tools').reasons[0]).toContain('file-parser');
      expect(body.compatibility.manualSteps.length).toBeGreaterThan(0);
    });

    it('reports nested skills as unsupported on a target without nesting when children are not included', async () => {
      const child = await createSkill(promptSpec(unique('Child')));
      const parent = await createSkill(compositeSpec(unique('Parent'), child.id));
      const notIncluded = (await getCompat(parent.id, { version: 1, ...F.claude })).json();
      expect(notIncluded.compatibility.level).toBe('unsupported');
      const included = (await getCompat(parent.id, { version: 1, ...F.claude, includeChildSkills: true })).json();
      expect(included.compatibility.level).toBe('partial');
    });
  });

  // ---------------- acknowledgement policy ----------------

  describe('PARTIAL requires an explicit acknowledgement', () => {
    it('blocks without acknowledgeWarnings and exports with it', async () => {
      const { id } = await createSkill(workflowSpec());
      const blocked = await postExport(id, { version: 1, ...F.markdown });
      expect(blocked.statusCode).toBe(400);
      const error = errorOf(blocked);
      expect(error.details.code).toBe('EXPORT_ACK_REQUIRED');
      expect(error.details.level).toBe('partial');
      expect(error.details.warnings.length).toBeGreaterThan(0);
      expect(error.details.manualSteps.length).toBeGreaterThan(0);

      const ok = await postExport(id, { version: 1, ...F.markdown, acknowledgeWarnings: true });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['x-export-compatibility']).toBe('partial');
    });

    it('a FULL export needs no acknowledgement', async () => {
      const { id } = await createSkill(workflowSpec());
      const res = await postExport(id, { version: 1, ...F.package });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-export-compatibility']).toBe('full');
    });
  });

  // ---------------- isolation / deletion / bad references ----------------

  describe('isolation and failure cases', () => {
    it('a Skill of another Workspace is 404 for export and compatibility', async () => {
      const { id } = await createSkill(promptSpec());
      const otherWs = await createWorkspace();
      const headers = { 'x-dev-workspace-id': otherWs };
      expect((await postExport(id, { version: 1, ...F.raw }, headers)).statusCode).toBe(404);
      expect((await getCompat(id, { version: 1, ...F.raw }, headers)).statusCode).toBe(404);
    });

    it('a soft-deleted Skill cannot be exported', async () => {
      const { id } = await createSkill(promptSpec());
      expect((await app.inject({ method: 'DELETE', url: `/skills/${id}` })).statusCode).toBe(204);
      const res = await postExport(id, { version: 1, ...F.markdown });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).details.code).toBe('EXPORT_SKILL_NOT_FOUND');
    });

    it.each(['draft', 'active', 'archived'])('exports a %s Skill', async (status) => {
      const { id } = await createSkill(promptSpec());
      if (status === 'active') await app.inject({ method: 'POST', url: `/skills/${id}/activate` });
      if (status === 'archived') await pool.query(`UPDATE skills SET status = 'archived' WHERE id = $1`, [id]);
      const res = await postExport(id, { version: 1, ...F.markdown });
      expect(res.statusCode).toBe(200);
    });

    it('a Tool missing from the Registry fails the export instead of being dropped', async () => {
      const skillId = randomUUID();
      const spec = workflowSpec();
      spec.execution.steps[0].refId = 'ghost-tool';
      await pool.query(
        `INSERT INTO skills (id, workspace_id, owner_id, name, description, skill_type, status, current_version)
         VALUES ($1, $2, $3, $4, 'd', 'workflow', 'draft', 1)`,
        [skillId, SEED_WS, SEED_USER, spec.name],
      );
      await pool.query(
        `INSERT INTO skill_versions (skill_id, version, spec_json, change_source, created_by) VALUES ($1, 1, $2, 'create', $3)`,
        [skillId, JSON.stringify(spec), SEED_USER],
      );
      const res = await postExport(skillId, { version: 1, ...F.markdown, acknowledgeWarnings: true });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details).toMatchObject({ code: 'EXPORT_TOOL_UNKNOWN', toolId: 'ghost-tool' });
    });
  });

  // ---------------- Sanitizer ----------------

  describe('Export Sanitizer', () => {
    it.each(['package', 'markdown', 'raw', 'claude'] as const)('blocks a secret in the Skill for %s (raw is not exempt)', async (key) => {
      const spec = promptSpec();
      spec.instructions.rules.push(`Authenticate with ${OPENAI_STYLE}`);
      const { id } = await createSkill(spec);
      const res = await postExport(id, { version: 1, ...F[key], acknowledgeWarnings: true });
      expect(res.statusCode).toBe(400);
      const error = errorOf(res);
      expect(error.details.code).toBe('EXPORT_SECRET_DETECTED');
      expect(error.details.findings).toEqual([{ path: '/instructions/rules/1', category: 'api_key' }]);
      expect(res.body).not.toContain(OPENAI_STYLE); // the value is never echoed
    });

    it('the compatibility endpoint reports the blocker up-front instead of failing', async () => {
      const spec = promptSpec();
      spec.description = `use ${OPENAI_STYLE}`;
      const { id } = await createSkill(spec);
      const res = await getCompat(id, { version: 1, ...F.markdown });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.blockers[0].code).toBe('EXPORT_SECRET_DETECTED');
      expect(body.blockers[0].findings).toEqual([{ path: '/description', category: 'api_key' }]);
      expect(body.lock).toBeNull();
      expect(res.body).not.toContain(OPENAI_STYLE);
    });
  });

  // ---------------- determinism ----------------

  describe('deterministic export', () => {
    it('the same inputs give a byte-identical ZIP and the same content hash', async () => {
      const { id } = await createSkill(workflowSpec());
      const body = { version: 1, ...F.package, includeSourceSpec: true };
      const a = await postExport(id, body);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const b = await postExport(id, body);
      expect(a.rawPayload.equals(b.rawPayload)).toBe(true);
      expect(a.headers['x-export-content-hash']).toBe(b.headers['x-export-content-hash']);
      expect(a.headers['x-exported-at']).not.toBe(b.headers['x-exported-at']); // time lives in metadata only
      expect(a.headers['x-exported-at']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const blob = Object.values(unzipText(a)).join('\n');
      expect(blob).not.toContain(a.headers['x-exported-at'] as string);
    });

    it('Raw and Markdown exports are reproducible too', async () => {
      const { id } = await createSkill(workflowSpec());
      for (const key of ['raw', 'markdown', 'claude'] as const) {
        const body = { version: 1, ...F[key], acknowledgeWarnings: true };
        const [a, b] = [await postExport(id, body), await postExport(id, body)];
        expect(sha256(a.rawPayload)).toBe(sha256(b.rawPayload));
      }
    });
  });

  // ---------------- internal ids ----------------

  describe('internal ids', () => {
    it('are absent from every file unless includeSourceSpec is on', async () => {
      const child = await createSkill(promptSpec(unique('Id Child')));
      const parent = await createSkill(compositeSpec(unique('Id Parent'), child.id));

      const off = await postExport(parent.id, { version: 1, ...F.package, includeChildSkills: true });
      expect(off.statusCode, off.body).toBe(200);
      const offBlob = Object.values(unzipText(off)).join('\n');
      expect(offBlob).not.toContain(parent.id);
      expect(offBlob).not.toContain(child.id);

      const on = await postExport(parent.id, { version: 1, ...F.package, includeChildSkills: true, includeSourceSpec: true });
      const files = unzipText(on);
      const skillJson = JSON.parse(Object.entries(files).find(([p]) => p.endsWith('/skill.json') && !p.includes('/children/'))![1]);
      expect(skillJson.source).toEqual({ skillId: parent.id, skillVersion: 1 });
    });
  });

  // ---------------- composite / child lock ----------------

  describe('Composite Skill and Child dependency lock', () => {
    it('includes Child Skills and locks the Child Version current at export time', async () => {
      const childName = unique('Parser Child');
      const child = await createSkill(promptSpec(childName, 'Child v1 objective.'));
      const parent = await createSkill(compositeSpec(unique('Composite'), child.id));

      const first = await postExport(parent.id, { version: 1, ...F.package, includeChildSkills: true });
      expect(first.statusCode, first.body).toBe(200);
      const files1 = unzipText(first);
      const root = Object.keys(files1)[0].split('/')[0];
      const childDir = Object.keys(files1).find((p) => p.includes('/children/'))!.split('/').slice(0, 3).join('/');
      expect(Object.keys(files1)).toEqual(expect.arrayContaining([`${childDir}/SKILL.md`, `${childDir}/skill.json`]));
      const manifest1 = JSON.parse(files1[`${root}/manifest.json`]);
      const [alias, dep1] = Object.entries<any>(manifest1.dependencies)[0];
      expect(alias).toMatch(/^child:/);
      expect(dep1).toMatchObject({ displayName: childName, version: 1, included: true });

      // The Child moves on to v2; the SAME Parent Version now locks Child v2 — honestly reported.
      const patch = await app.inject({
        method: 'PATCH',
        url: `/skills/${child.id}`,
        payload: { expectedVersion: 1, spec: promptSpec(childName, 'Child v2 objective.') },
      });
      expect(patch.statusCode).toBe(200);
      const second = await postExport(parent.id, { version: 1, ...F.package, includeChildSkills: true });
      const files2 = unzipText(second);
      const dep2 = JSON.parse(files2[`${root}/manifest.json`]).dependencies[alias];
      expect(dep2.version).toBe(2);
      expect(dep2.contentHash).not.toBe(dep1.contentHash);
      expect(second.headers['x-export-content-hash']).not.toBe(first.headers['x-export-content-hash']);
      expect(files2[`${childDir}/skill.json`]).toContain('Child v2 objective.');
      expect(files1[`${childDir}/skill.json`]).toContain('Child v1 objective.');
    });

    it('without includeChildSkills the dependency is still locked in the manifest but not shipped', async () => {
      const child = await createSkill(promptSpec(unique('Locked Child')));
      const parent = await createSkill(compositeSpec(unique('Locked Parent'), child.id));
      const res = await postExport(parent.id, { version: 1, ...F.package, acknowledgeWarnings: true });
      expect(res.statusCode, res.body).toBe(200); // partial: children not included → acknowledged
      const files = unzipText(res);
      expect(Object.keys(files).some((p) => p.includes('/children/'))).toBe(false);
      const manifest = JSON.parse(Object.entries(files).find(([p]) => p.endsWith('manifest.json'))![1]);
      expect(Object.values<any>(manifest.dependencies)[0]).toMatchObject({ version: 1, included: false });
    });

    it('a soft-deleted Child fails the export', async () => {
      const child = await createSkill(promptSpec(unique('Doomed Child')));
      const parent = await createSkill(compositeSpec(unique('Doomed Parent'), child.id));
      await app.inject({ method: 'DELETE', url: `/skills/${child.id}` });
      const res = await postExport(parent.id, { version: 1, ...F.package, includeChildSkills: true });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details).toMatchObject({ code: 'EXPORT_CHILD_UNAVAILABLE', stepId: 'delegate' });
    });

    it('a Child that belongs to another Workspace is unavailable (no cross-workspace leak)', async () => {
      const child = await createSkill(promptSpec(unique('Foreign Child')));
      const parent = await createSkill(compositeSpec(unique('Foreign Parent'), child.id));
      const otherWs = await createWorkspace();
      await pool.query(`UPDATE skills SET workspace_id = $1 WHERE id = $2`, [otherWs, child.id]);
      const res = await postExport(parent.id, { version: 1, ...F.package, includeChildSkills: true });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details.code).toBe('EXPORT_CHILD_UNAVAILABLE');
      expect(res.body).not.toContain(otherWs);
    });

    it('a dependency cycle is detected', async () => {
      const b = await createSkill(promptSpec(unique('Cycle B')));
      const a = await createSkill(compositeSpec(unique('Cycle A'), b.id));
      // Registry validation prevents saving a cycle, so create one the way a bug or manual DB edit could.
      await pool.query(
        `INSERT INTO skill_versions (skill_id, version, spec_json, change_source, created_by) VALUES ($1, 2, $2, 'manual', $3)`,
        [b.id, JSON.stringify(compositeSpec(unique('Cycle B'), a.id)), SEED_USER],
      );
      await pool.query(`UPDATE skills SET current_version = 2 WHERE id = $1`, [b.id]);
      const res = await postExport(a.id, { version: 1, ...F.package, includeChildSkills: true });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details.code).toBe('EXPORT_DEPENDENCY_CYCLE');
    });
  });

  // ---------------- Knowledge ----------------

  describe('Knowledge export', () => {
    it('documents are fail-closed: export_allowed defaults to false', async () => {
      const doc = await createDoc(unique('default.txt'), 'x');
      expect(doc.exportAllowed).toBe(false);
      const list = (await app.inject({ method: 'GET', url: '/documents' })).json().documents as any[];
      expect(list.find((d) => d.id === doc.id).exportAllowed).toBe(false);
    });

    it('Include Documents is denied without export_allowed (workspace + ready is NOT enough)', async () => {
      const doc = await createDoc('policy.txt', 'policy body');
      const { id } = await createSkill(knowledgeSpec(unique('KB'), [doc.id]));
      const res = await postExport(id, { version: 1, ...F.package, includeKnowledge: true });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).details).toMatchObject({
        code: 'EXPORT_DOCUMENT_NOT_ALLOWED',
        reasons: { export_not_allowed: 1 },
      });
      expect(res.body).not.toContain('policy.txt'); // a denied document's metadata is never exposed
    });

    it('admin allows → Include works → admin revokes → denied again', async () => {
      const doc = await createDoc('allowed.txt', 'line1\r\nline2');
      const { id } = await createSkill(knowledgeSpec(unique('KB2'), [doc.id]));

      const allow = await app.inject({ method: 'PATCH', url: `/documents/${doc.id}`, payload: { exportAllowed: true } });
      expect(allow.statusCode).toBe(200);
      expect(allow.json().document.exportAllowed).toBe(true);

      const ok = await postExport(id, { version: 1, ...F.package, includeKnowledge: true });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.headers['x-export-compatibility']).toBe('full');
      const files = unzipText(ok);
      const refPath = Object.keys(files).find((p) => p.includes('/references/'))!;
      expect(refPath).toMatch(/\/references\/document-[0-9a-f]{8}\.txt$/); // ASCII archive path; the display name stays in the manifest
      expect(files[refPath]).toBe('line1\nline2'); // CRLF normalized
      const manifest = JSON.parse(Object.entries(files).find(([p]) => p.endsWith('manifest.json'))![1]);
      expect(Object.values<any>(manifest.knowledge)[0]).toMatchObject({
        fileName: 'allowed.txt',
        included: true,
        contentHash: createHash('sha256').update('line1\nline2').digest('hex'),
      });

      await app.inject({ method: 'PATCH', url: `/documents/${doc.id}`, payload: { exportAllowed: false } });
      const denied = await postExport(id, { version: 1, ...F.package, includeKnowledge: true });
      expect(denied.statusCode).toBe(403);
    });

    it('a document that is not ready is denied even when export_allowed is true', async () => {
      const doc = await createDoc('processing.txt', 'x', true);
      await pool.query(`UPDATE documents SET status = 'processing' WHERE id = $1`, [doc.id]);
      const { id } = await createSkill(knowledgeSpec(unique('KB3'), [doc.id]));
      const res = await postExport(id, { version: 1, ...F.package, includeKnowledge: true });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).details.reasons).toEqual({ access: 1 });
    });

    it('References Only needs no export permission, never ships content, but needs acknowledgement', async () => {
      const doc = await createDoc('refs-only.txt', 'private body');
      const { id } = await createSkill(knowledgeSpec(unique('KB4'), [doc.id]));
      const unack = await postExport(id, { version: 1, ...F.package });
      expect(errorOf(unack).details.code).toBe('EXPORT_ACK_REQUIRED');
      const res = await postExport(id, { version: 1, ...F.package, acknowledgeWarnings: true });
      expect(res.statusCode).toBe(200);
      const files = unzipText(res);
      expect(Object.keys(files).some((p) => p.includes('/references/'))).toBe(false);
      expect(Object.values(files).join('\n')).not.toContain('private body');
      expect(Object.values(files).join('\n')).not.toContain(doc.id);
    });

    it('workspace-scoped knowledge is always References Only, with a warning', async () => {
      await createDoc('ws-wide.txt', 'ws content', true);
      const { id } = await createSkill(knowledgeSpec(unique('KB5'), [], 'workspace'));
      const compat = (await getCompat(id, { version: 1, ...F.package, includeKnowledge: true })).json();
      expect(compat.compatibility.warnings.map((w: any) => w.code)).toContain('EXPORT_KNOWLEDGE_WORKSPACE_REFERENCES_ONLY');
      const res = await postExport(id, { version: 1, ...F.package, includeKnowledge: true, acknowledgeWarnings: true });
      expect(res.statusCode).toBe(200);
      expect(Object.values(unzipText(res)).join('\n')).not.toContain('ws content');
    });

    it('Generic Markdown never embeds documents, even with includeKnowledge', async () => {
      const doc = await createDoc('md-doc.txt', 'embedded?', true);
      const { id } = await createSkill(knowledgeSpec(unique('KB6'), [doc.id]));
      const res = await postExport(id, { version: 1, ...F.markdown, includeKnowledge: true, acknowledgeWarnings: true });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('embedded?');
    });

    it('a deleted document, or one that moved to another Workspace, is 404', async () => {
      const gone = await createDoc('gone.txt', 'x');
      const moved = await createDoc('moved.txt', 'x');
      const a = await createSkill(knowledgeSpec(unique('KB7'), [gone.id]));
      const b = await createSkill(knowledgeSpec(unique('KB8'), [moved.id]));
      await app.inject({ method: 'DELETE', url: `/documents/${gone.id}` });
      const otherWs = await createWorkspace();
      await pool.query(`UPDATE documents SET workspace_id = $1 WHERE id = $2`, [otherWs, moved.id]);
      for (const skill of [a, b]) {
        const res = await postExport(skill.id, { version: 1, ...F.package, acknowledgeWarnings: true });
        expect(res.statusCode).toBe(404);
        expect(errorOf(res).details.code).toBe('EXPORT_DOCUMENT_NOT_FOUND');
      }
    });

    it('a secret inside an included document blocks the export', async () => {
      const doc = await createDoc('leaky.txt', `token ${OPENAI_STYLE}`, true);
      const { id } = await createSkill(knowledgeSpec(unique('KB9'), [doc.id]));
      const res = await postExport(id, { version: 1, ...F.package, includeKnowledge: true });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details.findings).toEqual([{ path: 'doc:leaky-txt', category: 'api_key' }]);
      expect(res.body).not.toContain(OPENAI_STYLE);
    });

    it('a hostile file name cannot escape references/ in the ZIP', async () => {
      const doc = await createDoc('../../../etc/passwd', 'harmless', true);
      const { id } = await createSkill(knowledgeSpec(unique('KB10'), [doc.id]));
      const res = await postExport(id, { version: 1, ...F.package, includeKnowledge: true });
      expect(res.statusCode, res.body).toBe(200);
      for (const path of Object.keys(unzipText(res))) {
        expect(path).not.toContain('..');
        expect(path.startsWith('/')).toBe(false);
      }
    });
  });

  // ---------------- Compatibility explains, Export enforces (knowledge permission) ----------------

  describe('knowledge permission: Compatibility explains (200, blocked) — Export enforces (403)', () => {
    async function skillWithForbiddenDoc() {
      const doc = await createDoc(`secret-roadmap-${randomUUID().slice(0, 6)}.txt`, 'top secret roadmap');
      const { id } = await createSkill(knowledgeSpec(unique('KB-blocked'), [doc.id]));
      return { id, doc };
    }

    it('Compatibility answers HTTP 200 with level "blocked" and a generic blocker — no names, ids or counts', async () => {
      const { id, doc } = await skillWithForbiddenDoc();
      for (const target of [F.package, F.claude]) {
        const res = await getCompat(id, { version: 1, ...target, includeKnowledge: true });
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json();
        expect(body.compatibility.level).toBe('blocked');
        expect(body.blockers).toEqual([
          { code: 'KNOWLEDGE_EXPORT_FORBIDDEN', message: 'One or more knowledge documents cannot be exported.', findings: [] },
        ]);
        expect(body.lock).toBeNull(); // the lock snapshot would list document metadata
        expect(body.effectiveOptions.includeKnowledge).toBe(false);
        expect(res.body).not.toContain(doc.fileName);
        expect(res.body).not.toContain(doc.id);
        expect(res.body).not.toContain('top secret roadmap');
      }
    });

    it('the real Export of the same request is a 403 that exposes nothing about the document', async () => {
      const { id, doc } = await skillWithForbiddenDoc();
      for (const target of [F.package, F.claude]) {
        const res = await postExport(id, { version: 1, ...target, includeKnowledge: true, acknowledgeWarnings: true });
        expect(res.statusCode).toBe(403);
        expect(errorOf(res).details).toEqual({ code: 'EXPORT_DOCUMENT_NOT_ALLOWED', reasons: { export_not_allowed: 1 } });
        expect(res.body).not.toContain(doc.fileName);
        expect(res.body).not.toContain(doc.id);
      }
    });

    it('without includeKnowledge the same Skill is not blocked (References Only)', async () => {
      const { id } = await skillWithForbiddenDoc();
      const body = (await getCompat(id, { version: 1, ...F.claude })).json();
      expect(body.blockers).toEqual([]);
      expect(body.compatibility.level).toBe('partial');
      expect(body.compatibility.summary.knowledge).toEqual({ documents: 1, included: 0, workspaceScope: false });
    });

    it('once an admin allows the document, Compatibility is no longer blocked and reports the knowledge', async () => {
      const { id, doc } = await skillWithForbiddenDoc();
      await app.inject({ method: 'PATCH', url: `/documents/${doc.id}`, payload: { exportAllowed: true } });
      const body = (await getCompat(id, { version: 1, ...F.claude, includeKnowledge: true })).json();
      expect(body.blockers).toEqual([]);
      expect(body.compatibility.level).toBe('full');
      expect(body.compatibility.summary.knowledge).toEqual({ documents: 1, included: 1, workspaceScope: false });
    });

    it('a secret blocker also yields level "blocked" with findings but no value', async () => {
      const spec = promptSpec();
      spec.description = `use ${OPENAI_STYLE}`;
      const { id } = await createSkill(spec);
      const body = (await getCompat(id, { version: 1, ...F.claude })).json();
      expect(body.compatibility.level).toBe('blocked');
      expect(body.blockers[0]).toMatchObject({ code: 'EXPORT_SECRET_DETECTED', findings: [{ path: '/description', category: 'api_key' }] });
    });
  });

  // ---------------- Claude: tool skill shows Required MCP ----------------

  describe('Claude compatibility summary', () => {
    it('a Tool Skill lists the tools it needs as Required MCP and is PARTIAL', async () => {
      const { id } = await createSkill(workflowSpec());
      const body = (await getCompat(id, { version: 1, ...F.claude })).json();
      expect(body.compatibility.level).toBe('partial');
      expect(body.compatibility.summary.requiredMcp).toEqual(['file-parser']);
      expect(body.compatibility.summary.unsupportedCapabilities.map((c: any) => c.id)).toContain('tools');
      const tools = body.compatibility.checks.find((c: any) => c.id === 'tools');
      expect(tools.reasons.join(' ')).toContain('MCP server');
    });

    it('PARTIAL claude export needs acknowledgement; UNSUPPORTED claude export is blocked even when acknowledged', async () => {
      const tool = await createSkill(workflowSpec());
      expect(errorOf(await postExport(tool.id, { version: 1, ...F.claude })).details.code).toBe('EXPORT_ACK_REQUIRED');
      expect((await postExport(tool.id, { version: 1, ...F.claude, acknowledgeWarnings: true })).statusCode).toBe(200);

      const child = await createSkill(promptSpec(unique('Claude Child')));
      const parent = await createSkill(compositeSpec(unique('Claude Parent'), child.id));
      const blocked = await postExport(parent.id, { version: 1, ...F.claude, acknowledgeWarnings: true });
      expect(blocked.statusCode).toBe(400);
      expect(errorOf(blocked).details).toMatchObject({ code: 'EXPORT_COMPATIBILITY_UNSUPPORTED', level: 'unsupported' });
      // the same Skill as a generic package is only a warning (not target-optimized)
      expect((await postExport(parent.id, { version: 1, ...F.package, acknowledgeWarnings: true })).statusCode).toBe(200);
    });
  });

  // ---------------- Document export permission API ----------------

  describe('PATCH /documents/:id (exportAllowed)', () => {
    it('is admin-only: a member gets 403 and nothing changes', async () => {
      const doc = await createDoc('perm.txt', 'x');
      const res = await app.inject({
        method: 'PATCH',
        url: `/documents/${doc.id}`,
        payload: { exportAllowed: true },
        headers: { 'x-dev-workspace-role': 'member' },
      });
      expect(res.statusCode).toBe(403);
      const row = await pool.query(`SELECT export_allowed FROM documents WHERE id = $1`, [doc.id]);
      expect(row.rows[0].export_allowed).toBe(false);
    });

    it('a member cannot self-promote through the body or any non-provider header', async () => {
      const doc = await createDoc('perm-escalate.txt', 'x');
      const res = await app.inject({
        method: 'PATCH',
        url: `/documents/${doc.id}`,
        payload: { exportAllowed: true, workspaceRole: 'admin', role: 'admin', isAdmin: true },
        headers: { 'x-dev-workspace-role': 'member', 'x-workspace-role': 'admin', 'x-role': 'admin', authorization: 'Bearer admin' },
      });
      expect(res.statusCode).toBe(403);
      const row = await pool.query(`SELECT export_allowed FROM documents WHERE id = $1`, [doc.id]);
      expect(row.rows[0].export_allowed).toBe(false);
    });

    it('validates the body and scopes to the caller Workspace', async () => {
      const doc = await createDoc('perm2.txt', 'x');
      const bad = await app.inject({ method: 'PATCH', url: `/documents/${doc.id}`, payload: { exportAllowed: 'yes' } });
      expect(bad.statusCode).toBe(400);
      const otherWs = await createWorkspace();
      const foreign = await app.inject({
        method: 'PATCH',
        url: `/documents/${doc.id}`,
        payload: { exportAllowed: true },
        headers: { 'x-dev-workspace-id': otherWs },
      });
      expect(foreign.statusCode).toBe(404);
      const missing = await app.inject({ method: 'PATCH', url: `/documents/${randomUUID()}`, payload: { exportAllowed: true } });
      expect(missing.statusCode).toBe(404);
    });
  });
});
