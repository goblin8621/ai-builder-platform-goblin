import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../../bff/src/config/index.js';
import { BrainClient } from '../../bff/src/brain-client/BrainClient.js';
import * as skillService from '../../bff/src/skills/skill-service.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.database.url });
const brainClient = new BrainClient(config);
const context = {
  userId: config.auth.devSeedUserId,
  workspaceId: config.auth.devSeedWorkspaceId,
  requestId: 'skill-builder-test',
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

// Uses Brain's default HeuristicModelClient (no ANTHROPIC_API_KEY in this
// environment) — see brain/app/skills/router.py. Exercises the real
// BFF -> Brain -> Builder -> BFF-save round trip, not just unit logic.
const infraAvailable = await isInfraAvailable();
if (!infraAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[skill-builder.test.ts] Postgres/Brain not reachable — skipping Skill Builder integration tests.');
}

describe.skipIf(!infraAvailable)('Skill Builder (integration, requires live Postgres + Brain)', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('builds and persists a prompt Skill from a natural-language request', async () => {
    const result = await skillService.buildSkillFromRequest(
      pool,
      brainClient,
      context,
      '입력받은 한국어 문장을 자연스러운 영어로 번역하는 Skill 만들어줘',
    );

    expect(result.action).toBe('draft');
    if (result.action !== 'draft') throw new Error('expected draft');
    expect(result.skill.currentVersion).toBe(1);
    expect(result.version.changeSource).toBe('create');
    expect(result.version.spec.skillType).toBe('prompt');
  });

  it('builds and persists a tool Skill referencing a known Tool Registry entry', async () => {
    const result = await skillService.buildSkillFromRequest(
      pool,
      brainClient,
      context,
      '서비스 상태를 조회하는 API를 호출하는 Skill 만들어줘',
    );

    expect(result.action).toBe('draft');
    if (result.action !== 'draft') throw new Error('expected draft');
    expect(result.version.spec.skillType).toBe('tool');
    expect(result.version.spec.execution.steps[0].refId).toBe('service-status');
  });

  it('refines an existing Skill via the Builder, recording change_source=ai_refine', async () => {
    const created = await skillService.buildSkillFromRequest(
      pool,
      brainClient,
      context,
      '한국어를 영어로 번역하는 Skill 만들어줘',
    );
    if (created.action !== 'draft') throw new Error('expected draft');

    const refined = await skillService.refineSkillFromRequest(
      pool,
      brainClient,
      context,
      created.skill.id,
      1,
      '항상 존댓말로 답변해줘',
    );

    expect(refined.action).toBe('update');
    if (refined.action !== 'update') throw new Error('expected update');
    expect(refined.skill.currentVersion).toBe(2);
    expect(refined.version.changeSource).toBe('ai_refine');
    expect(refined.version.spec.instructions.rules).toContain('항상 존댓말로 답변해줘');
    // Unrelated fields preserved through the refine round trip.
    expect(refined.version.spec.name).toBe(created.version.spec.name);
  });

  it('rejects refine with a stale expectedVersion', async () => {
    const created = await skillService.buildSkillFromRequest(pool, brainClient, context, '번역 Skill 만들어줘');
    if (created.action !== 'draft') throw new Error('expected draft');

    await skillService.refineSkillFromRequest(pool, brainClient, context, created.skill.id, 1, '변경 1');

    await expect(
      skillService.refineSkillFromRequest(pool, brainClient, context, created.skill.id, 1, '변경 2 (stale)'),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('returns not_found when refining a Skill that does not exist', async () => {
    await expect(
      skillService.refineSkillFromRequest(
        pool,
        brainClient,
        context,
        '00000000-0000-0000-0000-000000000000',
        1,
        '변경',
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
