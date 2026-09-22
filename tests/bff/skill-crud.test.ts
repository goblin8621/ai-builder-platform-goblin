import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../../bff/src/config/index.js';
import { BrainClient } from '../../bff/src/brain-client/BrainClient.js';
import * as skillService from '../../bff/src/skills/skill-service.js';
import type { SkillSpecV1 } from '../../contracts/skill-spec.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.database.url });
const brainClient = new BrainClient(config);
const context = {
  userId: config.auth.devSeedUserId,
  workspaceId: config.auth.devSeedWorkspaceId,
  requestId: 'skill-crud-test',
};

async function isInfraAvailable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    await brainClient.health(context);
    return true;
  } catch {
    return false;
  }
}

// Requires live Postgres (docker-compose) + Brain (uvicorn). Skips cleanly
// when either is unreachable instead of failing, since this is an
// integration suite, not a unit test.
const infraAvailable = await isInfraAvailable();
if (!infraAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[skill-crud.test.ts] Postgres/Brain not reachable — skipping Skill CRUD integration tests.');
}

function makePromptSpec(overrides: Partial<SkillSpecV1> = {}): SkillSpecV1 {
  return {
    schemaVersion: '1.0',
    name: 'Test Translator',
    description: 'test',
    skillType: 'prompt',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { translatedText: { type: 'string' } } },
    instructions: { objective: 'translate', rules: [] },
    model: { mode: 'user', modelId: null, allowUserOverride: true },
    capabilities: {
      webSearch: false,
      imageGeneration: false,
      codeExecution: false,
      dataAnalysis: false,
      fileAnalysis: false,
      knowledgeSearch: false,
      mcp: false,
    },
    knowledge: { mode: 'none', documentIds: [] },
    execution: { steps: [{ id: 'translate', name: 'Translate', type: 'llm' }] },
    runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 0, maxNestedSkillDepth: 0 },
    guardrails: [],
    usageExamples: [],
    metadata: { category: 'test', tags: [] },
    ...overrides,
  };
}

describe.skipIf(!infraAvailable)('Skill CRUD (integration, requires live Postgres + Brain)', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('creates a skill with version 1', async () => {
    const { skill, version } = await skillService.createSkill(
      pool,
      brainClient,
      context,
      makePromptSpec({ name: 'Create Test A' }),
    );
    expect(skill.currentVersion).toBe(1);
    expect(skill.status).toBe('draft');
    expect(version.version).toBe(1);
    expect(version.changeSource).toBe('create');
  });

  it('rejects a spec referencing an unknown modelId', async () => {
    const spec = makePromptSpec({
      name: 'Bad Model',
      model: { mode: 'fixed', modelId: 'does-not-exist', allowUserOverride: false },
    });
    await expect(skillService.createSkill(pool, brainClient, context, spec)).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('rejects a spec enabling an unsupported capability', async () => {
    // webSearch/imageGeneration/mcp remain unsupported through Phase 6 (no
    // external service integration); codeExecution/dataAnalysis/fileAnalysis/
    // knowledgeSearch became real in Phase 6 — see skill-run.test.ts for
    // coverage of those actually being usable now.
    const spec = makePromptSpec({ name: 'Bad Capability' });
    spec.capabilities.webSearch = true;
    await expect(skillService.createSkill(pool, brainClient, context, spec)).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('lists and fetches a created skill', async () => {
    const { skill } = await skillService.createSkill(pool, brainClient, context, makePromptSpec({ name: 'List Test' }));

    const list = await skillService.listSkills(pool, context);
    expect(list.some((s) => s.id === skill.id)).toBe(true);

    const fetched = await skillService.getSkill(pool, context, skill.id);
    expect(fetched.skill.id).toBe(skill.id);
    expect(fetched.version?.version).toBe(1);
  });

  it('updates a skill creating version 2, and rejects a stale expectedVersion', async () => {
    const { skill } = await skillService.createSkill(pool, brainClient, context, makePromptSpec({ name: 'Update Test' }));

    const updated = await skillService.updateSkill(
      pool,
      brainClient,
      context,
      skill.id,
      1,
      makePromptSpec({ name: 'Update Test v2' }),
    );
    expect(updated.skill.currentVersion).toBe(2);
    expect(updated.version.changeSource).toBe('manual');

    await expect(
      skillService.updateSkill(pool, brainClient, context, skill.id, 1, makePromptSpec({ name: 'Update Test v3 (stale)' })),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('activates a skill', async () => {
    const { skill } = await skillService.createSkill(pool, brainClient, context, makePromptSpec({ name: 'Activate Test' }));
    const activated = await skillService.activateSkill(pool, context, skill.id);
    expect(activated.status).toBe('active');
  });

  it('duplicates a skill into a fresh v1', async () => {
    const { skill } = await skillService.createSkill(
      pool,
      brainClient,
      context,
      makePromptSpec({ name: 'Duplicate Source' }),
    );
    const { skill: duplicated, version } = await skillService.duplicateSkill(pool, brainClient, context, skill.id);
    expect(duplicated.id).not.toBe(skill.id);
    expect(duplicated.currentVersion).toBe(1);
    expect(version.changeSource).toBe('create');
  });

  it('soft-deletes a skill so it disappears from list/get', async () => {
    const { skill } = await skillService.createSkill(pool, brainClient, context, makePromptSpec({ name: 'Delete Test' }));
    await skillService.deleteSkill(pool, context, skill.id);

    await expect(skillService.getSkill(pool, context, skill.id)).rejects.toMatchObject({ code: 'not_found' });
    const list = await skillService.listSkills(pool, context);
    expect(list.some((s) => s.id === skill.id)).toBe(false);
  });

  it('lists version history and restores an old version as a new append-only version', async () => {
    const { skill } = await skillService.createSkill(
      pool,
      brainClient,
      context,
      makePromptSpec({ name: 'Restore Test v1' }),
    );
    await skillService.updateSkill(pool, brainClient, context, skill.id, 1, makePromptSpec({ name: 'Restore Test v2' }));

    const versions = await skillService.listSkillVersions(pool, context, skill.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    const restored = await skillService.restoreSkillVersion(pool, brainClient, context, skill.id, 1);
    expect(restored.skill.currentVersion).toBe(3);
    expect(restored.version.changeSource).toBe('restore');
    expect(restored.version.spec.name).toBe('Restore Test v1');
  });

  it('rejects a direct self-reference skill cycle on update', async () => {
    const { skill } = await skillService.createSkill(
      pool,
      brainClient,
      context,
      makePromptSpec({ name: 'Self Cycle Test' }),
    );
    const cyclicSpec = makePromptSpec({
      name: 'Self Cycle Test',
      skillType: 'composite',
      execution: { steps: [{ id: 'call-self', name: 'Call self', type: 'skill', refId: skill.id }] },
    });

    await expect(
      skillService.updateSkill(pool, brainClient, context, skill.id, 1, cyclicSpec),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('rejects an indirect skill dependency cycle (A -> B -> A)', async () => {
    const { skill: skillA } = await skillService.createSkill(pool, brainClient, context, makePromptSpec({ name: 'Cycle A' }));

    const specB = makePromptSpec({
      name: 'Cycle B',
      skillType: 'composite',
      execution: { steps: [{ id: 'call-a', name: 'Call A', type: 'skill', refId: skillA.id }] },
    });
    const { skill: skillB } = await skillService.createSkill(pool, brainClient, context, specB);

    const specAReferencingB = makePromptSpec({
      name: 'Cycle A',
      skillType: 'composite',
      execution: { steps: [{ id: 'call-b', name: 'Call B', type: 'skill', refId: skillB.id }] },
    });

    await expect(
      skillService.updateSkill(pool, brainClient, context, skillA.id, 1, specAReferencingB),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('allows a valid composite skill referencing an existing child skill (no cycle)', async () => {
    const { skill: child } = await skillService.createSkill(pool, brainClient, context, makePromptSpec({ name: 'Child Skill' }));

    const parentSpec = makePromptSpec({
      name: 'Parent Skill',
      skillType: 'composite',
      execution: { steps: [{ id: 'call-child', name: 'Call child', type: 'skill', refId: child.id }] },
    });
    const { skill: parent } = await skillService.createSkill(pool, brainClient, context, parentSpec);
    expect(parent.currentVersion).toBe(1);
  });

  it('rejects a selected-knowledge documentId that does not exist in the workspace', async () => {
    const spec = makePromptSpec({
      name: 'Bad Document Ref',
      skillType: 'knowledge',
      knowledge: { mode: 'selected', documentIds: ['00000000-0000-0000-0000-000000000abc'] },
    });
    await expect(skillService.createSkill(pool, brainClient, context, spec)).rejects.toMatchObject({
      code: 'validation_error',
    });
  });
});
