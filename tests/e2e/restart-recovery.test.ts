/**
 * Phase 8 — Restart Recovery (00번/07번: "서비스 재시작 후에도 Skill과 과거
 * Run을 조회할 수 있어야 한다").
 *
 * BFF/Brain 둘 다 Run/Skill 상태를 메모리에 들고 있지 않는다(코드 감사로
 * 확인 — 모듈 레벨 캐시/Map이 전혀 없음, 모든 상태는 매 요청마다 Postgres에서
 * 읽고 씀). 이 테스트는 그 사실을 "완전히 새로운 프로세스 세계관"에
 * 대응하는 새 Pool + 새 BrainClient 인스턴스로 재현해 증명한다 — 기존 Pool을
 * 닫아 이전 연결을 완전히 버리고, 그 시점 이후로는 전부 새 객체로만 조회한다.
 *
 * (참고: Phase 7 브라우저 수동 검증 중 실제로 BFF 프로세스를 kill 후 재기동한
 * 뒤에도 이전에 만든 Skill/Run이 그대로 조회됐음을 이미 한 번 확인했다 — 이
 * 테스트는 그 관찰을 자동화된 형태로 재현한 것이다.)
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../../bff/src/config/index.js';
import { BrainClient } from '../../bff/src/brain-client/BrainClient.js';
import * as skillService from '../../bff/src/skills/skill-service.js';
import * as skillRunService from '../../bff/src/skill-runs/skill-run-service.js';
import type { SkillSpecV1 } from '../../contracts/skill-spec.js';

const config = loadConfig();
const setupPool = new Pool({ connectionString: config.database.url });
const setupBrainClient = new BrainClient(config);
const context = {
  userId: config.auth.devSeedUserId,
  workspaceId: config.auth.devSeedWorkspaceId,
  requestId: 'restart-recovery-test',
};

async function isInfraAvailable(): Promise<boolean> {
  try {
    await setupPool.query('SELECT 1');
    await setupBrainClient.health(context);
    return true;
  } catch {
    return false;
  }
}

const infraAvailable = await isInfraAvailable();
if (!infraAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[restart-recovery.test.ts] Postgres/Brain not reachable — skipping Phase 8 restart-recovery test.');
}

const spec: SkillSpecV1 = {
  schemaVersion: '1.0',
  name: 'Restart Recovery Test',
  description: 'test',
  skillType: 'prompt',
  inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  outputSchema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } },
  instructions: { objective: 'echo', rules: [] },
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
  execution: { steps: [{ id: 'respond', name: 'Respond', type: 'llm' }] },
  runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 0, maxNestedSkillDepth: 0 },
  guardrails: [],
  usageExamples: [],
  metadata: { category: 'test', tags: [] },
};

describe.skipIf(!infraAvailable)('Restart Recovery (Phase 8)', () => {
  let skillId: string;
  let runId: string;
  let skillVersionId: string;

  it('creates a Skill and a completed Run using the "before restart" connections', async () => {
    const { skill, version } = await skillService.createSkill(setupPool, setupBrainClient, context, spec);
    skillId = skill.id;
    skillVersionId = version.id;

    const { run } = await skillRunService.createAndExecuteRun(setupPool, setupBrainClient, context, skillId, {
      text: 'before restart',
    });
    expect(run.status).toBe('completed');
    runId = run.id;

    // "재시작"을 흉내내기 위해 이 시점의 연결을 완전히 끊는다 — 이후 assertion은
    // 전부 새로 만든 Pool/BrainClient(아래)로만 수행한다.
    await setupPool.end();
  });

  it('a brand-new Pool + BrainClient (simulating a fresh process) can still read the Skill and its Run', async () => {
    const freshPool = new Pool({ connectionString: config.database.url });
    const freshBrainClient = new BrainClient(config);
    try {
      const { skill, version } = await skillService.getSkill(freshPool, context, skillId);
      expect(skill.id).toBe(skillId);
      expect(version.id).toBe(skillVersionId);

      const { run, steps } = await skillRunService.getSkillRun(freshPool, context, runId);
      expect(run.id).toBe(runId);
      expect(run.status).toBe('completed');
      expect(run.output).toMatchObject({ result: expect.any(String) });
      expect(steps.length).toBeGreaterThan(0);

      // 재시작 이후에도 정상적으로 새 Run을 실행할 수 있어야 한다(과거 조회만
      // 가능한 반쪽짜리 복구가 아니라, 이후 정상 운영이 이어짐을 확인).
      const { run: newRun } = await skillRunService.createAndExecuteRun(freshPool, freshBrainClient, context, skillId, {
        text: 'after restart',
      });
      expect(newRun.status).toBe('completed');
      expect(newRun.skillVersionId).toBe(skillVersionId); // Version Pinning도 재시작과 무관하게 유지
    } finally {
      await freshPool.end();
    }
  });
});
