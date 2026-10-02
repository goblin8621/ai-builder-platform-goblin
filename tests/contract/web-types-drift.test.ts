/**
 * Phase 8 — Web Contract Drift 검출 (P8 사용자 결정사항 #2).
 *
 * `web/lib/types.ts`는 의도적으로 `contracts/*.ts`를 import하지 않고
 * 독립적으로 타입을 미러링한다(Web을 독립 배포 가능한 프로젝트로 유지하기
 * 위함). 이 테스트는 "런타임 의존성 없이, 최소한 드리프트는 검출한다"는
 * 절충안을 구현한다 — 대규모 OpenAPI codegen 없이 두 가지를 확인:
 *
 * 1. SkillSpec 계약: web 타입으로 만든 구체적인 SkillSpecV1 예시가 BFF/Brain이
 *    실제로 사용하는 유일한 검증 기준(`contracts/skill-spec.schema.json`,
 *    `bff/src/skills/skill-spec-validator.ts`가 로드)을 통과하는지 확인한다.
 *    누군가 web의 SkillSpecV1을 canonical schema와 다르게 바꾸면(필드 추가/
 *    누락/타입 변경) 여기서 실패한다.
 * 2. Web ↔ BFF API 응답 계약: 실제 BFF 서비스 계층이 반환하는 SkillRecord/
 *    SkillVersionRecord의 key set이 web/lib/types.ts가 선언한 key set과
 *    정확히 일치하는지 확인한다 — BFF가 필드를 추가/삭제/변경하면 여기서
 *    실패한다.
 *
 * (OpenAPI 기반 Web API 타입 자동 생성은 검토했으나, 이번 Phase 8 범위에서는
 * "현재 구조를 대규모로 변경하지 않는다"는 결정에 따라 보류 — DEVELOPMENT_LOG.md
 * 참고.)
 */
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../../bff/src/config/index.js';
import { BrainClient } from '../../bff/src/brain-client/BrainClient.js';
import * as skillService from '../../bff/src/skills/skill-service.js';
import { validateSkillSpec } from '../../bff/src/skills/skill-spec-validator.js';
import { emptySpec } from '../../web/lib/types.js';

describe('Web SkillSpecV1 mirror validates against the canonical schema', () => {
  it('emptySpec() (Web-typed blank-draft factory) fails ONLY on the empty required strings it intentionally leaves blank for the UI form', () => {
    // emptySpec() is a Draft placeholder (구성 탭 초기 상태), not something
    // meant to be saved as-is — the canonical schema's minLength:1 on
    // name/description/instructions.objective is expected to reject it.
    // Any OTHER error here means the two shapes have actually drifted.
    const result = validateSkillSpec(emptySpec());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const paths = result.errors.map((e) => e.path).sort();
      expect(paths).toEqual(['/description', '/instructions/objective', '/name']);
    }
  });

  it('a fully-populated Web-typed prompt Skill satisfies the canonical schema', () => {
    const spec = emptySpec({
      name: 'Drift Check Prompt Skill',
      description: 'Phase 8 contract drift check',
      instructions: { objective: 'Echo the input text back.', rules: [] },
    });
    const result = validateSkillSpec(spec);
    expect(result.valid).toBe(true);
  });

  it('a fully-populated Web-typed knowledge Skill satisfies the canonical schema', () => {
    const spec = emptySpec({
      name: 'Drift Check Knowledge Skill',
      description: 'Phase 8 contract drift check',
      instructions: { objective: 'Answer only from the provided documents.', rules: [] },
      skillType: 'knowledge',
      inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
      outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
      capabilities: {
        webSearch: false,
        imageGeneration: false,
        codeExecution: false,
        dataAnalysis: false,
        fileAnalysis: false,
        knowledgeSearch: true,
        mcp: false,
      },
      knowledge: { mode: 'workspace', documentIds: [] },
      execution: { steps: [{ id: 'search', name: 'Search', type: 'knowledge', inputMap: { query: { $ref: 'input.question' } } }] },
    });
    const result = validateSkillSpec(spec);
    expect(result.valid).toBe(true);
  });
});

const driftConfig = loadConfig();
const driftPool = new Pool({ connectionString: driftConfig.database.url });
const driftBrainClient = new BrainClient(driftConfig);
const driftContext = {
  userId: driftConfig.auth.devSeedUserId,
  workspaceId: driftConfig.auth.devSeedWorkspaceId,
  requestId: 'web-types-drift-test',
};

async function isDriftInfraAvailable(): Promise<boolean> {
  try {
    await driftPool.query('SELECT 1');
    await driftBrainClient.health(driftContext);
    return true;
  } catch {
    return false;
  }
}

const driftInfraAvailable = await isDriftInfraAvailable();
if (!driftInfraAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[web-types-drift.test.ts] Postgres/Brain not reachable — skipping API shape drift check.');
}

// Literal key lists mirroring web/lib/types.ts — deliberately hand-copied
// (not imported as a value; TS types don't exist at runtime) so a change to
// either side that the other doesn't know about fails this test.
const WEB_SKILL_RECORD_KEYS = [
  'id', 'workspaceId', 'ownerId', 'name', 'description', 'skillType', 'status',
  'visibility', 'currentVersion', 'deletedAt', 'createdAt', 'updatedAt',
].sort();
const WEB_SKILL_VERSION_RECORD_KEYS = [
  'id', 'skillId', 'version', 'spec', 'changeSource', 'changeSummary', 'createdBy', 'createdAt',
].sort();

describe.skipIf(!driftInfraAvailable)('Web SkillRecord/SkillVersionRecord mirror matches the real BFF response shape', () => {
  it('a real createSkill() response has exactly the fields web/lib/types.ts expects', async () => {
    const { skill, version } = await skillService.createSkill(
      driftPool,
      driftBrainClient,
      driftContext,
      emptySpec({
        name: 'Drift Shape Check',
        description: 'Phase 8 API shape drift check',
        instructions: { objective: 'Echo the input text back.', rules: [] },
      }),
    );
    try {
      expect(Object.keys(skill).sort()).toEqual(WEB_SKILL_RECORD_KEYS);
      expect(Object.keys(version).sort()).toEqual(WEB_SKILL_VERSION_RECORD_KEYS);
    } finally {
      await skillService.deleteSkill(driftPool, driftContext, skill.id);
      await driftPool.end();
    }
  });
});
