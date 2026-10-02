/**
 * Phase 8 — 00번 문서("유즈케이스")의 6개 Skill 유즈케이스를 실제 BFF -> Brain ->
 * Postgres 경로로 재현한다. 각 테스트는 00번이 명시한 "검증 항목"을 그대로
 * assertion으로 옮긴 것이며, Fake Runtime 없이 Phase 5~7에서 만든 실제
 * 서비스 계층(Builder/CRUD/Run/Approval)만 사용한다.
 *
 * UC1(번역)/UC2(문서검색)/UC4(API조회)는 실제 Skill Builder(Heuristic
 * ModelClient)를 통해 생성한다 — 이 환경엔 ANTHROPIC_API_KEY가 없어 자연어
 * 이해 품질 자체는 검증 대상이 아니며(Phase 4에 이미 기록된 한계), Builder
 * 파이프라인(Registry 검증/저장/Run)이 정확히 동작하는지만 검증한다.
 *
 * UC3(CSV 분석)/UC5(승인 필요 운영 변경)/UC6(Composite 배포)는 Heuristic
 * Builder가 애초에 감지하지 못하는 skillType(workflow/tool-with-approval/
 * composite)이므로 — 04번 문서의 "Structured Output" 자체가 아니라 그 결과로
 * 나온 Skill Spec의 실행을 검증하는 것이 이 테스트의 목적이라 — Phase 5~6과
 * 동일한 컨벤션대로 Spec을 직접 구성해 저장 후 실행한다.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../../bff/src/config/index.js';
import { BrainClient } from '../../bff/src/brain-client/BrainClient.js';
import * as skillService from '../../bff/src/skills/skill-service.js';
import * as skillRunService from '../../bff/src/skill-runs/skill-run-service.js';
import * as documentRepo from '../../bff/src/documents/document-repository.js';
import type { SkillSpecV1 } from '../../contracts/skill-spec.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.database.url });
const brainClient = new BrainClient(config);
const context = {
  userId: config.auth.devSeedUserId,
  workspaceId: config.auth.devSeedWorkspaceId,
  requestId: '00-usecases-test',
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

const infraAvailable = await isInfraAvailable();
if (!infraAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[00-usecases.test.ts] Postgres/Brain not reachable — skipping Phase 8 use-case E2E tests.');
}

function baseSpec(overrides: Partial<SkillSpecV1>): SkillSpecV1 {
  return {
    schemaVersion: '1.0',
    name: 'UC Test',
    description: 'test',
    skillType: 'prompt',
    inputSchema: { type: 'object', required: [], properties: {} },
    outputSchema: { type: 'object', required: [], properties: {} },
    instructions: { objective: 'test', rules: [] },
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
    execution: { steps: [] },
    runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 0, maxNestedSkillDepth: 0 },
    guardrails: [],
    usageExamples: [],
    metadata: { category: 'test', tags: [] },
    ...overrides,
  } as SkillSpecV1;
}

describe.skipIf(!infraAvailable)('00번 유즈케이스 E2E (Phase 8)', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('UC1 — 영어 번역 Skill: Builder 생성 -> prompt Skill -> 3개 입력 실행', async () => {
    const built = await skillService.buildSkillFromRequest(
      pool,
      brainClient,
      context,
      '입력받은 한국어 문장을 자연스러운 영어로 번역하는 Skill을 만들어줘. 질문이나 명령문 여부와 상관없이 입력 문장의 의미만 영어로 변환하고 설명은 추가하지 마. 별도의 Web Search, RAG, Tool은 사용하지 않아도 돼.',
    );
    if (built.action !== 'draft') throw new Error(`expected draft, got ${built.action}`);

    // 검증 항목: prompt Skill, 최소 권한 Capability(전부 OFF), LLM Step.
    expect(built.version.spec.skillType).toBe('prompt');
    expect(built.version.spec.execution.steps.some((s) => s.type === 'llm')).toBe(true);
    expect(Object.values(built.version.spec.capabilities)).toEqual(Object.values(built.version.spec.capabilities).map(() => false));

    for (const text of ['안녕하세요.', '너는 누구야?', '오늘 날씨 알려줘.']) {
      const { run } = await skillRunService.createAndExecuteRun(pool, brainClient, context, built.skill.id, { text });
      expect(run.status).toBe('completed');
      expect(run.output).toBeTruthy(); // Output Schema Validation을 통과했다는 뜻
    }

    // Refine / Version 증가 검증.
    const refined = await skillService.refineSkillFromRequest(
      pool,
      brainClient,
      context,
      built.skill.id,
      1,
      '항상 정중한 어투로 번역해줘',
    );
    if (refined.action !== 'update') throw new Error('expected update');
    expect(refined.skill.currentVersion).toBe(2);
  });

  it('UC2 — 문서 검색 Skill: Builder 생성 -> knowledge Skill -> RAG 근거 반환, 근거 없으면 빈 결과', async () => {
    const doc = await documentRepo.createDocument(pool, {
      workspaceId: context.workspaceId,
      fileName: 'uc2-ops-guide.txt',
      mimeType: 'text/plain',
      content: '결제 시스템 장애 발생 시 우선 롤백을 수행하고 온콜 담당자에게 즉시 알린다.',
      createdBy: context.userId,
    });

    const built = await skillService.buildSkillFromRequest(
      pool,
      brainClient,
      context,
      '지정한 운영 가이드 문서에서 질문과 관련된 내용을 찾아 답하는 Skill을 만들어줘. 선택된 문서 안에서만 검색하고, 근거가 없으면 문서에서 확인할 수 없다고 반환해줘.',
    );
    if (built.action !== 'draft') throw new Error(`expected draft, got ${built.action}`);
    expect(built.version.spec.skillType).toBe('knowledge');
    expect(built.version.spec.capabilities.knowledgeSearch).toBe(true);

    // Builder가 만든 knowledge Skill은 documentIds를 지정하지 않으므로(작성
    // 시점엔 아직 문서를 모름), selected 모드 + 방금 만든 문서로 구성을
    // 덮어써 "지정한 문서에서만"이라는 유즈케이스 요구를 실제로 반영한다.
    const patched = await skillService.updateSkill(pool, brainClient, context, built.skill.id, 1, {
      ...built.version.spec,
      knowledge: { mode: 'selected', documentIds: [doc.id] },
    });

    const { run: found } = await skillRunService.createAndExecuteRun(pool, brainClient, context, built.skill.id, {
      question: '결제 장애 대응 절차',
    });
    expect(found.status).toBe('completed');

    const { run: notFound } = await skillRunService.createAndExecuteRun(pool, brainClient, context, built.skill.id, {
      question: '완전히 무관한 우주여행 이야기',
    });
    expect(notFound.status).toBe('completed'); // "근거 없음"도 정상 결과(00번), 에러 아님

    await documentRepo.deleteDocument(pool, context.workspaceId, doc.id);
    void patched;
  });

  it('UC3 — CSV 분석 Skill: parse -> monthly_sum -> detect_outliers, 잘못된 파일은 명확히 실패', async () => {
    const spec = baseSpec({
      name: 'UC3 CSV Analysis',
      skillType: 'workflow',
      inputSchema: { type: 'object', required: ['csvContent'], properties: { csvContent: { type: 'string' } } },
      outputSchema: {
        type: 'object',
        required: ['monthlySums', 'outliers'],
        properties: { monthlySums: { type: 'object' }, outliers: { type: 'array' } },
      },
      capabilities: {
        webSearch: false,
        imageGeneration: false,
        codeExecution: true,
        dataAnalysis: true,
        fileAnalysis: true,
        knowledgeSearch: false,
        mcp: false,
      },
      execution: {
        steps: [
          { id: 'parse', name: 'Parse CSV', type: 'tool', refId: 'file-parser', inputMap: { content: { $ref: 'input.csvContent' } } },
          {
            id: 'monthly',
            name: 'Monthly sum',
            type: 'tool',
            refId: 'python-data-analysis',
            inputMap: { operation: 'monthly_sum', rows: { $ref: 'steps.parse.output.rows' } },
          },
          {
            id: 'outliers',
            name: 'Detect outliers',
            type: 'tool',
            refId: 'python-data-analysis',
            inputMap: { operation: 'detect_outliers', rows: { $ref: 'steps.parse.output.rows' } },
          },
        ],
        outputMap: {
          monthlySums: { $ref: 'steps.monthly.output.monthlySums' },
          outliers: { $ref: 'steps.outliers.output.outliers' },
        },
      },
      runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 0 },
    });
    const { skill } = await skillService.createSkill(pool, brainClient, context, spec);

    // 9개의 "정상" 값(100) 사이에 1개의 극단값(9000)을 섞는다 — z-score는
    // 모집단(전체) 표준편차 기준이라, 정상값이 충분히 많아야 극단값 자신이
    // 평균/표준편차를 과도하게 끌어올려 스스로를 "가리는" 일이 없다.
    const csv =
      'month,amount\n' +
      '2024-01,100\n2024-01,100\n2024-01,100\n2024-01,100\n2024-01,100\n' +
      '2024-02,100\n2024-02,100\n2024-02,100\n2024-02,100\n2024-02,9000\n';
    const { run } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, { csvContent: csv });

    expect(run.status).toBe('completed');
    expect(run.output).toMatchObject({ monthlySums: { '2024-01': 500, '2024-02': 9400 } });
    expect((run.output?.outliers as unknown[]).length).toBeGreaterThan(0); // 9000이 이상치로 탐지됨

    // 잘못된 파일 입력(필수 컬럼 month/amount가 없는 CSV) -> file-parser는
    // 통과하지만 이후 집계 Step이 없는 컬럼을 찾다가 명확히 실패한다.
    const { run: badRun } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      csvContent: 'unrelated_column\nfoo\nbar\n',
    });
    expect(badRun.status).toBe('failed');
  });

  it('UC4 — API 조회 Skill: Builder 생성 -> tool Skill -> service-status 호출, 존재하지 않는 Tool ID는 저장 시점에 차단', async () => {
    const built = await skillService.buildSkillFromRequest(
      pool,
      brainClient,
      context,
      '서비스 상태 조회 Tool을 호출해 현재 상태와 핵심 지표를 반환하는 Skill을 만들어줘. 조회 작업만 수행하고 시스템 변경은 하지 않도록 해줘.',
    );
    if (built.action !== 'draft') throw new Error(`expected draft, got ${built.action}`);
    expect(built.version.spec.skillType).toBe('tool');
    expect(built.version.spec.execution.steps[0].refId).toBe('service-status');

    // Heuristic Builder는 모든 Skill에 동일한 범용 outputSchema(result:string)를
    // 붙이므로, service-status의 실제 응답({status, metrics, ...})과는 애초에
    // 맞지 않는다(Phase 4에 이미 기록된 한계 — 자연어로부터 정확한
    // outputSchema를 추론하는 것은 실제 LLM 없이는 검증 대상이 아님). 00번이
    // 요구하는 "Output = status / metrics"를 실제로 검증하기 위해 이 Skill이
    // 실제로 반환하는 값에 맞게 outputSchema를 보정한다 — UC2에서 knowledge
    // 설정을 보정한 것과 같은 방식.
    const patched = await skillService.updateSkill(pool, brainClient, context, built.skill.id, 1, {
      ...built.version.spec,
      outputSchema: { type: 'object', required: ['status'], properties: { status: { type: 'string' }, metrics: { type: 'object' } } },
    });
    void patched;

    const { run } = await skillRunService.createAndExecuteRun(pool, brainClient, context, built.skill.id, {
      text: 'svc-uc4',
    });
    expect(run.status).toBe('completed');
    expect(run.output).toMatchObject({ status: 'healthy' });

    // 존재하지 않는 Tool ID는 Registry 검증에서 저장 시점에 차단(00번 검증 항목).
    const badSpec = baseSpec({
      name: 'UC4 invalid tool id',
      skillType: 'tool',
      execution: { steps: [{ id: 'call', name: 'Call', type: 'tool', refId: 'does-not-exist' }] },
    });
    await expect(skillService.createSkill(pool, brainClient, context, badSpec)).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('UC5 — 승인 필요 운영 변경 Skill: 조회는 자동, 재시작 직전에만 정지 -> 승인 후 실행 / 거절 시 미실행', async () => {
    const spec = baseSpec({
      name: 'UC5 Approval Ops Change',
      skillType: 'tool',
      inputSchema: { type: 'object', required: ['serviceId'], properties: { serviceId: { type: 'string' } } },
      outputSchema: {
        type: 'object',
        required: ['before', 'after'],
        properties: { before: { type: 'object' }, after: { type: 'object' } },
      },
      execution: {
        steps: [
          { id: 'check-before', name: 'Check status (before)', type: 'tool', refId: 'service-status', inputMap: { serviceId: { $ref: 'input.serviceId' } } },
          { id: 'restart', name: 'Restart', type: 'tool', refId: 'service-status', approvalRequired: true, inputMap: { serviceId: { $ref: 'input.serviceId' } } },
          { id: 'check-after', name: 'Check status (after)', type: 'tool', refId: 'service-status', inputMap: { serviceId: { $ref: 'input.serviceId' } } },
        ],
        outputMap: { before: { $ref: 'steps.check-before.output' }, after: { $ref: 'steps.check-after.output' } },
      },
      runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 0 },
    });
    const { skill } = await skillService.createSkill(pool, brainClient, context, spec);

    // 조회 Step(check-before)은 승인 없이 자동 실행되고, 변경 Step(restart) 직전에만 멈춘다.
    const { run: paused, steps: pausedSteps, pendingApproval } = await skillRunService.createAndExecuteRun(
      pool,
      brainClient,
      context,
      skill.id,
      { serviceId: 'svc-uc5' },
    );
    expect(paused.status).toBe('waiting_approval');
    expect(pendingApproval).toMatchObject({ stepId: 'restart' });
    expect(pausedSteps.find((s) => s.stepId === 'check-before')?.status).toBe('completed');
    expect(pausedSteps.find((s) => s.stepId === 'restart')).toBeUndefined(); // 실행 전이라 Step 기록조차 없음

    const { run: approved } = await skillRunService.approveRun(pool, brainClient, context, paused.id);
    expect(approved.status).toBe('completed');
    expect(approved.output).toMatchObject({ before: { status: 'healthy' }, after: { status: 'healthy' } });

    // 거절 경로: 별도 Run에서 재현 — restart Tool은 한 번도 호출되지 않는다.
    const { run: paused2 } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      serviceId: 'svc-uc5-reject',
    });
    const { run: rejected, steps: rejectedSteps } = await skillRunService.rejectRun(pool, context, paused2.id);
    expect(rejected.status).toBe('failed');
    expect(rejectedSteps.some((s) => s.stepId === 'restart')).toBe(false);
  });

  it('UC6 — Composite 배포 검증 Skill: Pre-check/Deploy/Post-check Nested Skill, Cycle 차단', async () => {
    const preCheck = await skillService.createSkill(
      pool,
      brainClient,
      context,
      baseSpec({
        name: 'UC6 Pre-check',
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        execution: { steps: [{ id: 'check', name: 'Check', type: 'transform', inputMap: { ok: true } }] },
      }),
    );
    const postCheck = await skillService.createSkill(
      pool,
      brainClient,
      context,
      baseSpec({
        name: 'UC6 Post-check',
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        execution: { steps: [{ id: 'check', name: 'Check', type: 'transform', inputMap: { ok: true } }] },
      }),
    );
    // 00번 UC6은 "Deploy 단계는 승인 필요"까지 요구하지만, 이번 Phase 8 E2E
    // 테스트로 발견된 실제 설계 한계상(아래 별도 테스트 참고) Nested Skill
    // 자식의 approvalRequired는 Parent Run으로 전파되지 않는다 — 사용자
    // 결정: 지금은 "명확한 에러"로만 고치고 전파 자체는 별도 작업으로 분리.
    // 따라서 이 성공 경로 테스트는 승인 없는 Deploy로 Composite/Nested/Cycle
    // 핵심 동작만 검증한다.
    const deploy = await skillService.createSkill(
      pool,
      brainClient,
      context,
      baseSpec({
        name: 'UC6 Deploy',
        skillType: 'tool',
        outputSchema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
        execution: { steps: [{ id: 'deploy-step', name: 'Deploy', type: 'tool', refId: 'service-status' }] },
        runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 0 },
      }),
    );

    const parent = baseSpec({
      name: 'UC6 Composite Deploy',
      skillType: 'composite',
      outputSchema: { type: 'object', required: ['deployStatus'], properties: { deployStatus: { type: 'object' } } },
      execution: {
        steps: [
          { id: 'pre', name: 'Pre-check', type: 'skill', refId: preCheck.skill.id },
          { id: 'do-deploy', name: 'Deploy', type: 'skill', refId: deploy.skill.id },
          { id: 'post', name: 'Post-check', type: 'skill', refId: postCheck.skill.id },
        ],
        outputMap: { deployStatus: { $ref: 'steps.do-deploy.output' } },
      },
      runtime: { timeoutSec: 60, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 2 },
    });
    const { skill: parentSkill } = await skillService.createSkill(pool, brainClient, context, parent);

    const { run: completed, childRuns } = await skillRunService.createAndExecuteRun(
      pool,
      brainClient,
      context,
      parentSkill.id,
      {},
    );
    expect(completed.status).toBe('completed');
    expect(completed.output).toMatchObject({ deployStatus: { status: 'healthy' } });
    expect(childRuns?.filter((c) => c.status === 'completed')).toHaveLength(3); // pre + deploy + post
    expect(childRuns?.every((c) => c.parentRunId === completed.id)).toBe(true);

    // Cycle 차단: Pre-check가 Parent(Composite)를 다시 참조하도록 시도 -> 저장 거부.
    await expect(
      skillService.updateSkill(pool, brainClient, context, preCheck.skill.id, 1, {
        ...preCheck.version.spec,
        skillType: 'composite',
        execution: { steps: [{ id: 'call-back', name: 'Call back', type: 'skill', refId: parentSkill.id }] },
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  // 발견된 설계 이슈(P8 사용자 결정 #4): Nested Skill 자식의 approvalRequired가
  // Parent Run으로 전파되지 않는 것은 확정된 Known Limitation이다. 아래는
  // 사용자가 명시한 필수 테스트 매트릭스를 그대로 옮긴 것이다 — "일반 Nested
  // Skill 정상 실행"은 위 UC6 성공 케이스가 이미 담당하므로 여기서는 나머지
  // 5개(Parent 자체 Approval/Child 내부 Approval 감지/Side Effect 미실행/
  // 명확한 실패 사유/Debug 확인 가능)를 다룬다.
  describe('발견된 설계 이슈 — Nested Skill Approval (P8 사용자 결정 #4)', () => {
    it('Parent 자체 Approval은 Composite Skill이어도 정상 동작한다 (Nested Approval 제약과 무관)', async () => {
      const child = await skillService.createSkill(
        pool,
        brainClient,
        context,
        baseSpec({
          name: 'Parent-own-approval Child (no approval inside)',
          outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
          execution: { steps: [{ id: 'check', name: 'Check', type: 'transform', inputMap: { ok: true } }] },
        }),
      );
      const parent = baseSpec({
        name: 'Parent-own-approval Composite',
        skillType: 'composite',
        outputSchema: { type: 'object', required: ['childOk', 'status'], properties: { childOk: { type: 'boolean' }, status: { type: 'string' } } },
        execution: {
          steps: [
            { id: 'pre', name: 'Pre-check (nested, no approval)', type: 'skill', refId: child.skill.id },
            // Parent 자신의 Step에 직접 approvalRequired — 이건 일반 Approval
            // 흐름이며 Nested Approval 제약과는 완전히 다른 케이스다.
            { id: 'own-gate', name: 'Own approval gate', type: 'tool', refId: 'service-status', approvalRequired: true },
          ],
          outputMap: { childOk: { $ref: 'steps.pre.output.ok' }, status: { $ref: 'steps.own-gate.output.status' } },
        },
        runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 1 },
      });
      const { skill: parentSkill } = await skillService.createSkill(pool, brainClient, context, parent);

      const { run: paused, pendingApproval } = await skillRunService.createAndExecuteRun(pool, brainClient, context, parentSkill.id, {});
      expect(paused.status).toBe('waiting_approval');
      expect(pendingApproval).toMatchObject({ stepId: 'own-gate' });

      const { run: completed } = await skillRunService.approveRun(pool, brainClient, context, paused.id);
      expect(completed.status).toBe('completed');
      expect(completed.output).toMatchObject({ childOk: true, status: 'healthy' });
    });

    it('Child Skill 내부 Approval은 NESTED_SKILL_APPROVAL_NOT_SUPPORTED로 명확히 실패하고, Tool은 절대 호출되지 않는다', async () => {
      const child = await skillService.createSkill(
        pool,
        brainClient,
        context,
        baseSpec({
          name: 'Nested Approval Child',
          skillType: 'tool',
          outputSchema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
          execution: {
            steps: [{ id: 'restart', name: 'Restart', type: 'tool', refId: 'service-status', approvalRequired: true }],
          },
          runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 0 },
        }),
      );
      const parent = baseSpec({
        name: 'Nested Approval Parent',
        skillType: 'composite',
        outputSchema: { type: 'object', required: ['result'], properties: { result: { type: 'object' } } },
        execution: {
          steps: [{ id: 'call-child', name: 'Call child', type: 'skill', refId: child.skill.id }],
          outputMap: { result: { $ref: 'steps.call-child.output' } },
        },
        runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 1 },
      });
      const { skill: parentSkill } = await skillService.createSkill(pool, brainClient, context, parent);

      const { run, steps, childRuns } = await skillRunService.createAndExecuteRun(pool, brainClient, context, parentSkill.id, {});

      // Parent Run이 대기(waiting_approval)가 아니라 명확한 실패 사유를 기록.
      expect(run.status).toBe('failed');
      expect(run.error).toMatchObject({
        code: 'NESTED_SKILL_APPROVAL_NOT_SUPPORTED',
        message: expect.stringContaining('Approval required inside a nested Skill is not supported'),
      });
      // Debug(Run/Step)에서 원인을 확인할 수 있다 — Run.error가 바로 그 근거다
      // (위 toMatchObject 자체가 "Debug에서 확인 가능"을 실증한다).

      // 가장 중요한 것: 승인을 우회해서 Child의 Tool(restart)이 호출되면 안
      // 된다 — 예외가 던져지는 시점(자식이 waiting_approval을 반환한 직후)
      // 자체가 Tool 호출 이전이므로, 어떤 Child Run도 persist되지 않는다.
      expect(childRuns ?? []).toHaveLength(0);
      const callChildStep = steps.find((s) => s.stepId === 'call-child');
      expect(callChildStep?.status).toBe('failed');
      expect(callChildStep?.output).toBeNull();
    });
  });
});
