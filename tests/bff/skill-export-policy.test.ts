/**
 * Phase 9 — BFF export policy, permission predicates and request
 * normalization. Brain is stubbed so the policy rules are tested in
 * isolation (the real Brain is covered by skill-export.test.ts).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { loadConfig } from '../../bff/src/config/index.js';
import { BrainClient } from '../../bff/src/brain-client/BrainClient.js';
import { DevAuthContextProvider } from '../../bff/src/client-context/DevAuthContextProvider.js';
import * as skillService from '../../bff/src/skills/skill-service.js';
import type { SkillRecord } from '../../bff/src/skills/skill-repository.js';
import type { DocumentRecord } from '../../bff/src/documents/document-repository.js';
import {
  canAccessSkill,
  canManageDocumentExport,
  documentExportDenial,
} from '../../bff/src/skill-exports/export-permissions.js';
import {
  exportSkill,
  normalizeCompatibilityQuery,
  normalizeExportBody,
} from '../../bff/src/skill-exports/export.service.js';
import type { ExportCompileResponse } from '../../contracts/export.js';
import type { RequestContext } from '../../contracts/common-types.js';
import type { SkillSpecV1 } from '../../contracts/skill-spec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const validPortableSkillJson = readFileSync(path.join(here, '../contract/fixtures/portable-skill/valid-prompt.portable.json'), 'utf-8');

const config = loadConfig();
const context: RequestContext = {
  userId: config.auth.devSeedUserId,
  workspaceId: config.auth.devSeedWorkspaceId,
  requestId: 'export-policy-test',
};

// ---------------- pure: permission predicates ----------------

function doc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'd', workspaceId: context.workspaceId, fileName: 'a.txt', mimeType: 'text/plain', storageKey: 'k',
    status: 'ready', exportAllowed: true, createdBy: 'u', createdAt: '', ...overrides,
  };
}

describe('document export permission = workspace AND access AND export_allowed', () => {
  it('allows only when all three hold', () => {
    expect(documentExportDenial(context, doc())).toBeNull();
  });
  it('denies another workspace first', () => {
    expect(documentExportDenial(context, doc({ workspaceId: 'other' }))).toBe('workspace');
  });
  it('denies a document that is not ready (access)', () => {
    for (const status of ['uploaded', 'processing', 'failed'] as const) {
      expect(documentExportDenial(context, doc({ status }))).toBe('access');
    }
  });
  it('denies when export_allowed is false even though workspace and status are fine', () => {
    expect(documentExportDenial(context, doc({ exportAllowed: false }))).toBe('export_not_allowed');
  });
});

describe('canManageDocumentExport (admin only, fail-closed)', () => {
  it('admin yes; member no; absent role no', () => {
    expect(canManageDocumentExport({ ...context, workspaceRole: 'admin' })).toBe(true);
    expect(canManageDocumentExport({ ...context, workspaceRole: 'member' })).toBe(false);
    expect(canManageDocumentExport(context)).toBe(false);
  });
});

describe('canAccessSkill', () => {
  const skill = (o: Partial<SkillRecord> = {}): SkillRecord => ({
    id: 's', workspaceId: context.workspaceId, ownerId: 'u', name: 'n', description: 'd', skillType: 'prompt',
    status: 'draft', visibility: 'private', currentVersion: 1, deletedAt: null, createdAt: '', updatedAt: '', ...o,
  });
  it('requires the same workspace and a non-deleted skill', () => {
    expect(canAccessSkill(context, skill())).toBe(true);
    expect(canAccessSkill(context, skill({ workspaceId: 'other' }))).toBe(false);
    expect(canAccessSkill(context, skill({ deletedAt: new Date().toISOString() }))).toBe(false);
  });
});

// ---------------- pure: DevAuthContextProvider role ----------------

describe('DevAuthContextProvider workspaceRole', () => {
  const provider = (auth: Partial<ReturnType<typeof loadConfig>['auth']> = {}) =>
    new DevAuthContextProvider({ ...config, auth: { ...config.auth, ...auth } });

  it('defaults to admin and honors the configured role', () => {
    expect(provider().resolve({ headers: {} }).workspaceRole).toBe('admin');
    expect(provider({ devWorkspaceRole: 'member' }).resolve({ headers: {} }).workspaceRole).toBe('member');
  });
  it('accepts a dev override header only for valid values and only when overrides are enabled', () => {
    expect(provider().resolve({ headers: { 'x-dev-workspace-role': 'member' } }).workspaceRole).toBe('member');
    expect(provider().resolve({ headers: { 'x-dev-workspace-role': 'superuser' } }).workspaceRole).toBe('admin');
    expect(
      provider({ devAllowContextOverrideHeaders: false, devWorkspaceRole: 'member' }).resolve({
        headers: { 'x-dev-workspace-role': 'admin' },
      }).workspaceRole,
    ).toBe('member');
  });
});

// ---------------- pure: request normalization ----------------

describe('request normalization', () => {
  it('POST body: strings/booleans are parsed, defaults are all false', () => {
    const n = normalizeExportBody({ version: 3, target: 'claude', format: 'skill-package' });
    expect(n).toMatchObject({
      version: 3, target: 'claude', format: 'skill-package',
      includeKnowledge: false, includeChildSkills: false, includeSourceSpec: false, acknowledgeWarnings: false,
    });
  });
  it('target and format are both required and trimmed', () => {
    expect(() => normalizeExportBody({ version: 1, format: 'markdown' })).toThrow(/target/);
    expect(() => normalizeExportBody({ version: 1, target: 'generic' })).toThrow(/format/);
    expect(() => normalizeExportBody({ version: 1, target: '  ', format: 'markdown' })).toThrow(/target/);
    expect(normalizeExportBody({ version: 1, target: ' claude ', format: ' skill-package ' })).toMatchObject({ target: 'claude', format: 'skill-package' });
  });
  it('compatibility query: string booleans, and acknowledgeWarnings is never accepted from a query', () => {
    expect(
      normalizeCompatibilityQuery({ version: '5', target: 'claude', format: 'skill-package', includeKnowledge: 'true', includeChildSkills: '1', acknowledgeWarnings: 'true' }),
    ).toMatchObject({ version: 5, target: 'claude', includeKnowledge: true, includeChildSkills: true, acknowledgeWarnings: false });
  });
  it('version must be an explicit positive integer', () => {
    for (const version of [undefined, null, 0, -1, 1.5, 'abc', 'latest', '']) {
      expect(() => normalizeExportBody({ version: version as never, target: 'generic', format: 'raw-spec' })).toThrow(/version/);
    }
  });
});

// ---------------- policy with a stubbed Brain ----------------

const pool = new Pool({ connectionString: config.database.url });
const realBrain = new BrainClient(config);
const infraAvailable = await (async () => {
  try {
    await pool.query('SELECT 1');
    await realBrain.health(context);
    return true;
  } catch {
    return false;
  }
})();
if (!infraAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[skill-export-policy.test.ts] Postgres/Brain not reachable — skipping stubbed-Brain policy tests.');
}

const formatDescriptor = (id: string, extra: object = {}) => ({
  id, displayName: id, contentType: 'application/zip', targetOptimized: false,
  embedsKnowledge: false, embedsChildSkills: false, embedsSourceSpec: false, adapterAvailable: true, ...extra,
});
const CATALOG = {
  targets: [
    { id: 'generic', displayName: 'Generic', formats: [formatDescriptor('markdown'), formatDescriptor('portable-package', { embedsKnowledge: true })] },
    { id: 'claude', displayName: 'Claude', formats: [formatDescriptor('skill-package', { targetOptimized: true, embedsKnowledge: true })] },
    { id: 'pending', displayName: 'Pending', formats: [formatDescriptor('bundle', { adapterAvailable: false })] },
  ],
};

function stubBrain(response: Partial<ExportCompileResponse>): BrainClient {
  const full: ExportCompileResponse = {
    compatibility: { target: 'generic', format: 'markdown', level: 'full', checks: [], warnings: [], manualSteps: [], summary: { requiredMcp: [], knowledge: { documents: 0, included: 0, workspaceScope: false }, unsupportedCapabilities: [] } },
    effectiveOptions: { includeKnowledge: false, includeChildSkills: false, includeSourceSpec: false },
    blockers: [],
    manifest: null,
    files: [{ path: 'x.md', content: '# x\n' }],
    packageRoot: null,
    filename: 'x-v1.md',
    contentType: 'text/markdown; charset=utf-8',
    contentHash: 'a'.repeat(64),
    ...response,
  };
  return { exportCompile: async () => full, exportTargets: async () => CATALOG } as unknown as BrainClient;
}

const compat = (level: 'full' | 'partial' | 'unsupported') => ({
  target: 'x', format: 'y', level, checks: [],
  summary: { requiredMcp: [], knowledge: { documents: 0, included: 0, workspaceScope: false }, unsupportedCapabilities: [] },
  warnings: [{ code: 'COMPAT_TOOLS', message: 'cannot provide tools', checkId: 'tools' }], manualSteps: ['do a thing'],
});

async function seedSkill(): Promise<string> {
  const spec: SkillSpecV1 = {
    schemaVersion: '1.0', name: `Policy ${randomUUID().slice(0, 8)}`, description: 'd', skillType: 'prompt',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    instructions: { objective: 'o', rules: [] }, model: { mode: 'user', modelId: null, allowUserOverride: true },
    capabilities: { webSearch: false, imageGeneration: false, codeExecution: false, dataAnalysis: false, fileAnalysis: false, knowledgeSearch: false, mcp: false },
    knowledge: { mode: 'none', documentIds: [] }, execution: { steps: [{ id: 's', name: 'S', type: 'llm' }] },
    runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 0, maxNestedSkillDepth: 0 },
    guardrails: [], usageExamples: [], metadata: { category: 'test', tags: [] },
  };
  return (await skillService.createSkill(pool, realBrain, context, spec)).skill.id;
}

describe.skipIf(!infraAvailable)('export policy (stubbed Brain)', () => {
  afterAll(async () => {
    await pool.end();
  });

  const TARGETS = {
    markdown: { target: 'generic', format: 'markdown' },
    package: { target: 'generic', format: 'portable-package' },
    claude: { target: 'claude', format: 'skill-package' },
  } as const;
  const request = (kind: keyof typeof TARGETS, extra: object = {}) => normalizeExportBody({ version: 1, ...TARGETS[kind], ...extra });

  it('FULL exports without acknowledgement', async () => {
    const id = await seedSkill();
    const result = await exportSkill(pool, stubBrain({ compatibility: compat('full') }), context, id, request('markdown'));
    expect(result.metadata.level).toBe('full');
    expect(new TextDecoder().decode(result.body)).toBe('# x\n');
  });

  it.each(['partial', 'unsupported'] as const)('%s needs acknowledgeWarnings for a generic (non-optimized) format', async (level) => {
    const id = await seedSkill();
    const brain = stubBrain({ compatibility: compat(level) });
    await expect(exportSkill(pool, brain, context, id, request('markdown'))).rejects.toMatchObject({
      details: { code: 'EXPORT_ACK_REQUIRED', level, manualSteps: ['do a thing'] },
    });
    const ok = await exportSkill(pool, brain, context, id, request('markdown', { acknowledgeWarnings: true }));
    expect(ok.metadata.level).toBe(level);
  });

  it('UNSUPPORTED blocks a Target Optimized format (claude) even when warnings are acknowledged', async () => {
    const id = await seedSkill();
    const brain = stubBrain({ compatibility: compat('unsupported') });
    await expect(
      exportSkill(pool, brain, context, id, request('claude', { acknowledgeWarnings: true })),
    ).rejects.toMatchObject({ details: { code: 'EXPORT_COMPATIBILITY_UNSUPPORTED', level: 'unsupported' } });
  });

  it('PARTIAL claude export is allowed once acknowledged', async () => {
    const id = await seedSkill();
    const brain = stubBrain({ compatibility: compat('partial') });
    await expect(exportSkill(pool, brain, context, id, request('claude'))).rejects.toMatchObject({
      details: { code: 'EXPORT_ACK_REQUIRED' },
    });
    expect((await exportSkill(pool, brain, context, id, request('claude', { acknowledgeWarnings: true }))).metadata.level).toBe('partial');
  });

  it('unsupported target / format / missing adapter are three distinct errors, checked before any Skill lookup', async () => {
    const brain = stubBrain({});
    const ghost = randomUUID(); // does not exist: proves the catalog check runs first
    const run = (target: string, format: string) =>
      exportSkill(pool, brain, context, ghost, normalizeExportBody({ version: 1, target, format }));
    await expect(run('nope', 'x')).rejects.toMatchObject({ details: { code: 'EXPORT_TARGET_UNSUPPORTED', supported: ['generic', 'claude', 'pending'] } });
    await expect(run('claude', 'markdown')).rejects.toMatchObject({ details: { code: 'EXPORT_FORMAT_UNSUPPORTED', supported: ['skill-package'] } });
    await expect(run('pending', 'bundle')).rejects.toMatchObject({ details: { code: 'EXPORT_TARGET_ADAPTER_UNAVAILABLE', target: 'pending' } });
  });

  it('never packages if Brain returned blockers or no files (defense in depth)', async () => {
    const id = await seedSkill();
    const blocker = { code: 'EXPORT_SECRET_DETECTED' as const, message: 'm', findings: [{ path: '/x', category: 'api_key' }] };
    await expect(
      exportSkill(pool, stubBrain({ blockers: [blocker] }), context, id, request('markdown')),
    ).rejects.toMatchObject({ details: { code: 'EXPORT_BLOCKED' } });
    await expect(exportSkill(pool, stubBrain({ files: [] }), context, id, request('markdown'))).rejects.toMatchObject({
      details: { code: 'EXPORT_BLOCKED' },
    });
  });

  it('a package response is zipped under the package root; a single file is returned as-is', async () => {
    const id = await seedSkill();
    const brain = stubBrain({
      packageRoot: 'my-skill',
      filename: 'my-skill-v1.zip',
      contentType: 'application/zip',
      files: [
        { path: 'SKILL.md', content: '# a\n' },
        { path: 'skill.json', content: validPortableSkillJson },
      ],
    });
    const result = await exportSkill(pool, brain, context, id, request('package'));
    const entries = unzipSync(result.body);
    expect(Object.keys(entries)).toEqual(['my-skill/SKILL.md', 'my-skill/skill.json']);
    expect(strFromU8(entries['my-skill/SKILL.md'])).toBe('# a\n');
    expect(result.filename).toBe('my-skill-v1.zip');
  });

  it('contract guard: refuses to package a skill.json that violates the PortableSkill contract', async () => {
    const id = await seedSkill();
    const brain = stubBrain({
      packageRoot: 'my-skill',
      filename: 'my-skill-v1.zip',
      contentType: 'application/zip',
      files: [{ path: 'skill.json', content: JSON.stringify({ ...JSON.parse(validPortableSkillJson), provider: 'x' }) }],
    });
    await expect(exportSkill(pool, brain, context, id, request('package'))).rejects.toMatchObject({
      code: 'internal_error',
      details: { code: 'EXPORT_CONTRACT_VIOLATION', path: 'skill.json' },
    });
  });

  it('records the export time only in response metadata', async () => {
    const id = await seedSkill();
    const result = await exportSkill(pool, stubBrain({}), context, id, request('markdown'));
    expect(result.metadata.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new TextDecoder().decode(result.body)).not.toContain(result.metadata.exportedAt);
  });
});
