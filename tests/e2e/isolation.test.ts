/**
 * Phase 8 — Workspace / Knowledge Isolation (07번 8절, 00번 UC2 검증 항목,
 * 07번 13절 회귀 체크리스트 "Workspace Isolation"/"Knowledge Isolation").
 *
 * 두 번째 Workspace를 이 테스트가 직접 만들어(fixture) Workspace A/B 사이에
 * Skill과 Document가 서로 보이지 않고, 문서 ID를 추측해도 Knowledge 검색
 * 결과가 새어나가지 않음을 실제 Skill Run 경로로 확인한다.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../bff/src/config/index.js';
import { BrainClient } from '../../bff/src/brain-client/BrainClient.js';
import * as skillService from '../../bff/src/skills/skill-service.js';
import * as skillRunService from '../../bff/src/skill-runs/skill-run-service.js';
import * as documentRepo from '../../bff/src/documents/document-repository.js';
import type { SkillSpecV1 } from '../../contracts/skill-spec.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.database.url });
const brainClient = new BrainClient(config);
const contextA = {
  userId: config.auth.devSeedUserId,
  workspaceId: config.auth.devSeedWorkspaceId,
  requestId: 'isolation-test-a',
};

async function isInfraAvailable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    await brainClient.health(contextA);
    return true;
  } catch {
    return false;
  }
}

const infraAvailable = await isInfraAvailable();
if (!infraAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[isolation.test.ts] Postgres/Brain not reachable — skipping Phase 8 isolation tests.');
}

function knowledgeSpec(): SkillSpecV1 {
  return {
    schemaVersion: '1.0',
    name: 'Isolation Knowledge Skill',
    description: 'test',
    skillType: 'knowledge',
    inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['found'], properties: { found: { type: 'array' } } },
    instructions: { objective: 'search', rules: [] },
    model: { mode: 'user', modelId: null, allowUserOverride: true },
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
    execution: {
      steps: [{ id: 'search', name: 'Search', type: 'knowledge', inputMap: { query: { $ref: 'input.question' } } }],
      outputMap: { found: { $ref: 'steps.search.output.results' } },
    },
    runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 0, maxNestedSkillDepth: 0 },
    guardrails: [],
    usageExamples: [],
    metadata: { category: 'test', tags: [] },
  };
}

describe.skipIf(!infraAvailable)('Workspace / Knowledge Isolation (Phase 8)', () => {
  let workspaceBId: string;
  const contextB = () => ({ userId: contextA.userId, workspaceId: workspaceBId, requestId: 'isolation-test-b' });

  afterAll(async () => {
    if (workspaceBId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceBId]);
    await pool.end();
  });

  it('creates a second Workspace fixture for cross-tenant checks', async () => {
    const id = randomUUID();
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [id, 'Phase 8 Isolation Workspace B']);
    workspaceBId = id;
    expect(workspaceBId).toBeTruthy();
  });

  it('a Skill created in Workspace A is invisible from Workspace B (not_found, not silently empty)', async () => {
    const { skill } = await skillService.createSkill(pool, brainClient, contextA, {
      ...knowledgeSpec(),
      knowledge: { mode: 'none', documentIds: [] },
      execution: { steps: [{ id: 'noop', name: 'Noop', type: 'transform', inputMap: { found: [] } }] },
      capabilities: { ...knowledgeSpec().capabilities, knowledgeSearch: false },
    });

    await expect(skillService.getSkill(pool, contextB(), skill.id)).rejects.toMatchObject({ code: 'not_found' });

    const listInB = await skillService.listSkills(pool, contextB());
    expect(listInB.some((s) => s.id === skill.id)).toBe(false);
  });

  it('Knowledge search never crosses Workspace boundaries, even when the exact documentId is guessed', async () => {
    const docA = await documentRepo.createDocument(pool, {
      workspaceId: contextA.workspaceId,
      fileName: 'workspace-a-secret.txt',
      mimeType: 'text/plain',
      content: 'Workspace A의 내부 장애 대응 절차: 1단계 롤백, 2단계 온콜 호출.',
      createdBy: contextA.userId,
    });
    const docB = await documentRepo.createDocument(pool, {
      workspaceId: workspaceBId,
      fileName: 'workspace-b-secret.txt',
      mimeType: 'text/plain',
      content: 'Workspace B의 기밀 계약 조건: 단가 1200만원, 계약기간 2년.',
      createdBy: contextA.userId,
    });

    // Workspace A의 Skill이 mode: 'selected'로 Workspace B 문서의 실제 ID를
    // (마치 추측/탈취한 것처럼) 그대로 지정하면, Registry 검증
    // (documentIdsExist는 workspaceId로 스코프됨)이 그 ID를 "존재하지 않음"
    // 으로 취급해 애초에 SAVE 시점에 거부한다 — Run까지 갈 필요도 없이 더
    // 강한 격리 보장이다.
    await expect(
      skillService.createSkill(pool, brainClient, contextA, {
        ...knowledgeSpec(),
        name: 'Cross-workspace probe',
        knowledge: { mode: 'selected', documentIds: [docB.id] },
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    // 대조군: Workspace A 자신의 문서는 정상적으로 검색된다.
    const { skill: legitSkill } = await skillService.createSkill(pool, brainClient, contextA, {
      ...knowledgeSpec(),
      name: 'Same-workspace control',
      knowledge: { mode: 'selected', documentIds: [docA.id] },
    });
    const { run: legitRun } = await skillRunService.createAndExecuteRun(pool, brainClient, contextA, legitSkill.id, {
      question: '장애 대응 절차 알려줘',
    });
    expect(legitRun.status).toBe('completed');
    expect((legitRun.output?.found as unknown[]).length).toBeGreaterThan(0);

    await documentRepo.deleteDocument(pool, contextA.workspaceId, docA.id);
    await documentRepo.deleteDocument(pool, workspaceBId, docB.id);
  });

  it('a Document created in Workspace B does not appear in Workspace A\'s document list', async () => {
    const docB = await documentRepo.createDocument(pool, {
      workspaceId: workspaceBId,
      fileName: 'b-only.txt',
      mimeType: 'text/plain',
      content: 'only visible in workspace B',
      createdBy: contextA.userId,
    });

    const listedInA = await documentRepo.listDocuments(pool, contextA.workspaceId);
    expect(listedInA.some((d) => d.id === docB.id)).toBe(false);

    await documentRepo.deleteDocument(pool, workspaceBId, docB.id);
  });
});
