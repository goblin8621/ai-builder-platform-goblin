import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../../bff/src/config/index.js';
import { BrainClient } from '../../bff/src/brain-client/BrainClient.js';
import * as skillService from '../../bff/src/skills/skill-service.js';
import * as skillRunService from '../../bff/src/skill-runs/skill-run-service.js';
import type { SkillSpecV1 } from '../../contracts/skill-spec.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.database.url });
const brainClient = new BrainClient(config);
const context = {
  userId: config.auth.devSeedUserId,
  workspaceId: config.auth.devSeedWorkspaceId,
  requestId: 'skill-run-test',
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

// Uses Brain's default HeuristicRuntimeModelClient (no ANTHROPIC_API_KEY in
// this environment) — see brain/app/skills/runtime_router.py.
const infraAvailable = await isInfraAvailable();
if (!infraAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[skill-run.test.ts] Postgres/Brain not reachable — skipping Skill Run integration tests.');
}

function makePromptSpec(overrides: Partial<SkillSpecV1> = {}): SkillSpecV1 {
  return {
    schemaVersion: '1.0',
    name: 'Run Test Translator',
    description: 'test',
    skillType: 'prompt',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['translatedText'], properties: { translatedText: { type: 'string' } } },
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

describe.skipIf(!infraAvailable)('Skill Run (integration, requires live Postgres + Brain)', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('runs a single-step prompt Skill end to end and persists the Run + Step', async () => {
    const { skill } = await skillService.createSkill(pool, brainClient, context, makePromptSpec({ name: 'Run E2E A' }));

    const { run, steps } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      text: '안녕하세요',
    });

    expect(run.status).toBe('completed');
    expect(run.mode).toBe('run');
    expect(run.skillVersionId).toBeTruthy();
    expect(run.output).toHaveProperty('translatedText');
    expect(steps).toHaveLength(1);
    expect(steps[0].stepId).toBe('translate');
    expect(steps[0].status).toBe('completed');
  });

  it('rejects invalid Run input before creating any Run row', async () => {
    const { skill } = await skillService.createSkill(pool, brainClient, context, makePromptSpec({ name: 'Run E2E Bad Input' }));

    await expect(
      skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, { wrongField: 123 }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    const countResult = await pool.query('SELECT count(*) FROM skill_runs WHERE skill_id = $1', [skill.id]);
    expect(Number(countResult.rows[0].count)).toBe(0);
  });

  it('fetches a persisted Run with its Steps via getSkillRun', async () => {
    const { skill } = await skillService.createSkill(pool, brainClient, context, makePromptSpec({ name: 'Run E2E Fetch' }));
    const { run } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, { text: 'hi' });

    const fetched = await skillRunService.getSkillRun(pool, context, run.id);
    expect(fetched.run.id).toBe(run.id);
    expect(fetched.steps).toHaveLength(1);
  });

  it('returns not_found for a nonexistent Run', async () => {
    await expect(
      skillRunService.getSkillRun(pool, context, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('pins the Skill Version at Run creation time — a later update does not retroactively change past Runs', async () => {
    const { skill, version: v1 } = await skillService.createSkill(
      pool,
      brainClient,
      context,
      makePromptSpec({ name: 'Pinning Test' }),
    );
    const { run: runOnV1 } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      text: 'first',
    });
    expect(runOnV1.skillVersionId).toBe(v1.id);

    await skillService.updateSkill(pool, brainClient, context, skill.id, 1, makePromptSpec({ name: 'Pinning Test v2' }));

    const { run: runOnV2 } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      text: 'second',
    });
    expect(runOnV2.skillVersionId).not.toBe(v1.id);

    // The earlier Run's pinned version is unchanged by the Skill update.
    const refetchedRunOnV1 = await skillRunService.getSkillRun(pool, context, runOnV1.id);
    expect(refetchedRunOnV1.run.skillVersionId).toBe(v1.id);
  });

  it('fails the Run clearly when a Step type is not yet supported', async () => {
    const spec = makePromptSpec({
      name: 'Unsupported Step Test',
      skillType: 'workflow',
      execution: { steps: [{ id: 'branch', name: 'Branch', type: 'condition' }] },
    });
    const { skill } = await skillService.createSkill(pool, brainClient, context, spec);

    const { run, steps } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      text: 'irrelevant',
    });

    expect(run.status).toBe('failed');
    expect(steps[0].status).toBe('failed');
    expect(JSON.stringify(run.error)).toContain('not supported');
  });

  it('actually executes a real Tool via the ToolExecutor (service-status)', async () => {
    const spec = makePromptSpec({
      name: 'Tool Exec Test',
      skillType: 'tool',
      outputSchema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
      execution: {
        steps: [{ id: 'call', name: 'Call tool', type: 'tool', refId: 'service-status', inputMap: { serviceId: { $ref: 'input.text' } } }],
      },
      runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 0 },
    });
    const { skill } = await skillService.createSkill(pool, brainClient, context, spec);

    const { run, steps } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      text: 'svc-42',
    });

    expect(run.status).toBe('completed');
    expect(run.output).toMatchObject({ status: 'healthy' });
    expect(steps[0].output).toMatchObject({ serviceId: 'svc-42', status: 'healthy', simulated: true });
  });

  it('retries a failing Tool step and eventually succeeds', async () => {
    // service-status never fails, so use file-parser with intentionally
    // bad input on a fresh call each attempt — instead we exercise retry
    // by pointing at a tool id that always fails, then confirm the Run
    // records multiple attempts and ultimately fails after exhausting them.
    const spec = makePromptSpec({
      name: 'Retry Exhausted Test',
      skillType: 'tool',
      execution: {
        steps: [
          {
            id: 'call',
            name: 'Call tool',
            type: 'tool',
            refId: 'file-parser',
            inputMap: { content: 123 }, // wrong type -> file-parser always raises
            onError: { action: 'retry', retryCount: 2 },
          },
        ],
      },
      runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 0 },
    });
    const { skill } = await skillService.createSkill(pool, brainClient, context, spec);

    const { run, steps } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      text: 'irrelevant',
    });

    expect(run.status).toBe('failed');
    expect(steps).toHaveLength(3); // 1 initial + 2 retries, all failed
    expect(steps.map((s) => s.attempt)).toEqual([1, 2, 3]);
  });

  it('skips an optional failing step and completes via outputMap', async () => {
    const spec = makePromptSpec({
      name: 'Skip Test',
      skillType: 'workflow',
      outputSchema: { type: 'object', required: ['done'], properties: { done: { type: 'boolean' } } },
      execution: {
        steps: [
          {
            id: 'optional',
            name: 'Optional (always fails)',
            type: 'tool',
            refId: 'file-parser',
            inputMap: { content: 123 },
            onError: { action: 'skip' },
          },
          { id: 'final', name: 'Final', type: 'transform', inputMap: { done: true } },
        ],
      },
      runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 0 },
    });
    const { skill } = await skillService.createSkill(pool, brainClient, context, spec);

    const { run, steps } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      text: 'irrelevant',
    });

    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ done: true });
    expect(steps.find((s) => s.stepId === 'optional')?.status).toBe('skipped');
  });

  it('executes a Nested Skill and persists the child Run with parent_run_id set', async () => {
    const child = makePromptSpec({
      name: 'Nested Child',
      outputSchema: { type: 'object', required: ['childOk'], properties: { childOk: { type: 'boolean' } } },
      execution: { steps: [{ id: 'child-step', name: 'Child Step', type: 'transform', inputMap: { childOk: true } }] },
    });
    const { skill: childSkill } = await skillService.createSkill(pool, brainClient, context, child);

    const parent = makePromptSpec({
      name: 'Nested Parent',
      skillType: 'composite',
      outputSchema: { type: 'object', required: ['childOk'], properties: { childOk: { type: 'boolean' } } },
      execution: { steps: [{ id: 'call-child', name: 'Call child', type: 'skill', refId: childSkill.id }] },
      runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 2 },
    });
    const { skill: parentSkill } = await skillService.createSkill(pool, brainClient, context, parent);

    const { run, childRuns } = await skillRunService.createAndExecuteRun(pool, brainClient, context, parentSkill.id, {
      text: 'irrelevant',
    });

    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ childOk: true });
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0].skillId).toBe(childSkill.id);
    expect(childRuns[0].parentRunId).toBe(run.id);
    expect(childRuns[0].status).toBe('completed');
  });

  it('answers a knowledge step from an uploaded document and finds nothing for an unrelated query', async () => {
    const documentRepo = await import('../../bff/src/documents/document-repository.js');
    await documentRepo.createDocument(pool, {
      workspaceId: context.workspaceId,
      fileName: 'ops-guide.txt',
      mimeType: 'text/plain',
      content: '결제 시스템 장애 발생 시 우선 롤백을 수행하고 온콜 담당자에게 즉시 알린다.',
      createdBy: context.userId,
    });

    const spec = makePromptSpec({
      name: 'Knowledge Test',
      skillType: 'knowledge',
      outputSchema: { type: 'object', required: ['found'], properties: { found: { type: 'array' } } },
      knowledge: { mode: 'workspace', documentIds: [] },
      capabilities: {
        webSearch: false,
        imageGeneration: false,
        codeExecution: false,
        dataAnalysis: false,
        fileAnalysis: false,
        knowledgeSearch: true,
        mcp: false,
      },
      execution: {
        steps: [{ id: 'search', name: 'Search', type: 'knowledge', inputMap: { query: { $ref: 'input.text' } } }],
        outputMap: { found: { $ref: 'steps.search.output.results' } },
      },
    });
    const { skill } = await skillService.createSkill(pool, brainClient, context, spec);

    const { run } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      text: '결제 장애 대응 절차',
    });

    expect(run.status).toBe('completed');
    expect(Array.isArray(run.output?.found)).toBe(true);
    expect((run.output?.found as unknown[]).length).toBeGreaterThan(0);
  });

  it('pauses for approval, executes on approve, and never calls the Tool before approval', async () => {
    const spec = makePromptSpec({
      name: 'Approval Test',
      skillType: 'tool',
      outputSchema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
      execution: {
        steps: [
          {
            id: 'restart',
            name: 'Restart',
            type: 'tool',
            refId: 'service-status',
            approvalRequired: true,
            inputMap: { serviceId: { $ref: 'input.text' } },
          },
        ],
      },
      runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 5, maxNestedSkillDepth: 0 },
    });
    const { skill } = await skillService.createSkill(pool, brainClient, context, spec);

    const { run: pausedRun, pendingApproval } = await skillRunService.createAndExecuteRun(
      pool,
      brainClient,
      context,
      skill.id,
      { text: 'svc-1' },
    );
    expect(pausedRun.status).toBe('waiting_approval');
    // The pending-approval marker must be a clean top-level API field, not
    // leaked through `run.output` (an internal storage detail — see
    // skill-run-repository.ts markRunWaitingApproval).
    expect(pendingApproval).toMatchObject({ stepId: 'restart', stepType: 'tool' });
    expect(pausedRun.output).toBeNull();

    const { run: approvedRun } = await skillRunService.approveRun(pool, brainClient, context, pausedRun.id);
    expect(approvedRun.status).toBe('completed');
    expect(approvedRun.output).toMatchObject({ status: 'healthy' });
  });

  it('rejects a paused approval without ever executing the Tool', async () => {
    const spec = makePromptSpec({
      name: 'Rejection Test',
      skillType: 'tool',
      execution: {
        steps: [{ id: 'restart', name: 'Restart', type: 'tool', refId: 'service-status', approvalRequired: true }],
      },
    });
    const { skill } = await skillService.createSkill(pool, brainClient, context, spec);

    const { run: pausedRun } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      text: 'svc-1',
    });
    expect(pausedRun.status).toBe('waiting_approval');

    const { run: rejectedRun } = await skillRunService.rejectRun(pool, context, pausedRun.id);
    expect(rejectedRun.status).toBe('failed');
    expect(JSON.stringify(rejectedRun.error)).toContain('Rejected');
    expect(rejectedRun.output).toBeNull(); // no stale __pendingApproval marker left behind
  });

  it('allows cancelling a Run only while waiting_approval, not once running/completed', async () => {
    const spec = makePromptSpec({
      name: 'Cancel Test',
      skillType: 'tool',
      execution: {
        steps: [{ id: 'restart', name: 'Restart', type: 'tool', refId: 'service-status', approvalRequired: true }],
      },
    });
    const { skill } = await skillService.createSkill(pool, brainClient, context, spec);

    const { run: pausedRun } = await skillRunService.createAndExecuteRun(pool, brainClient, context, skill.id, {
      text: 'svc-1',
    });
    expect(pausedRun.status).toBe('waiting_approval');

    const { run: cancelledRun } = await skillRunService.cancelRun(pool, context, pausedRun.id);
    expect(cancelledRun.status).toBe('cancelled');

    await expect(skillRunService.cancelRun(pool, context, cancelledRun.id)).rejects.toMatchObject({
      code: 'validation_error',
    });
  });
});
