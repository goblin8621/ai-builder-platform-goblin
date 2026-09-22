import type { Pool } from 'pg';
import { AppError } from '../errors/index.js';
import type { RequestContext } from '../client-context/RequestContext.js';
import type { BrainClient } from '../brain-client/BrainClient.js';
import type { RunResult, StepResult as RuntimeStepResult } from '../../../contracts/runtime.js';
import type { SkillSpecV1 } from '../../../contracts/skill-spec.js';
import * as skillRepo from '../skills/skill-repository.js';
import * as documentRepo from '../documents/document-repository.js';
import { validateAgainstJsonSchema } from './input-validator.js';
import * as runRepo from './skill-run-repository.js';
import type { SkillRunMode } from './skill-run-repository.js';

const NETWORK_OVERHEAD_MS = 5_000;

/**
 * Nested Skill / Knowledge data Brain needs but can't fetch itself (no DB
 * access — 06번). Resolved fresh on every `/runtime/execute` call,
 * including on Approval resume, since the Skill Registry / Knowledge base
 * could have changed while a Run was paused.
 */
async function buildExecutionContext(pool: Pool, context: RequestContext, spec: SkillSpecV1) {
  const [childSkillsMap, knowledgeCorpus] = await Promise.all([
    skillRepo.resolveChildSkillsRecursive(pool, context.workspaceId, spec, spec.runtime.maxNestedSkillDepth),
    documentRepo.getKnowledgeCorpus(pool, context.workspaceId, spec.knowledge),
  ]);
  const childSkills = Object.fromEntries(
    Object.entries(childSkillsMap).map(([id, ref]) => [id, { skillVersionId: ref.skillVersionId, spec: ref.spec }]),
  );
  return { childSkills, knowledgeCorpus };
}

/**
 * Persists a RunResult's Step trace, recursively creating REAL skill_runs
 * rows (with parent_run_id set) for any Nested Skill `childRun` (02번
 * Parent/Child Run) — Brain never writes to the database itself.
 */
async function persistSteps(
  pool: Pool,
  context: RequestContext,
  runId: string,
  mode: SkillRunMode,
  steps: RuntimeStepResult[],
): Promise<void> {
  await runRepo.insertRunSteps(
    pool,
    steps.map((step) => ({
      runId,
      stepId: step.stepId,
      stepType: step.stepType,
      status: step.status,
      attempt: step.attempt,
      input: step.input,
      output: step.output ?? null,
      error: step.error ?? null,
    })),
  );

  for (const step of steps) {
    if (!step.childRun) continue;
    const childRun = await runRepo.createSkillRun(pool, {
      workspaceId: context.workspaceId,
      skillId: step.childRun.skillId,
      skillVersionId: step.childRun.skillVersionId,
      parentRunId: runId,
      mode,
      input: step.input,
      requestId: context.requestId,
      createdBy: context.userId,
    });
    await runRepo.completeSkillRun(pool, {
      runId: childRun.id,
      status: step.childRun.status,
      output: step.childRun.output ?? null,
      error: step.childRun.error ? { message: step.childRun.error } : null,
    });
    await persistSteps(pool, context, childRun.id, mode, step.childRun.steps);
  }
}

async function applyRunResult(
  pool: Pool,
  context: RequestContext,
  runId: string,
  mode: SkillRunMode,
  result: RunResult,
) {
  await persistSteps(pool, context, runId, mode, result.steps);

  const run =
    result.status === 'waiting_approval'
      ? await runRepo.markRunWaitingApproval(pool, runId, {
          stepId: result.pendingApproval!.stepId,
          stepType: result.pendingApproval!.stepType,
          input: result.pendingApproval!.input,
        })
      : await runRepo.completeSkillRun(pool, {
          runId,
          status: result.status,
          output: result.output ?? null,
          error: result.error ? { message: result.error } : null,
        });

  const steps = await runRepo.listRunSteps(pool, runId);
  const childRuns = await runRepo.listChildRuns(pool, runId);
  return { run, steps, childRuns };
}

/**
 * `POST /skill-runs` (05번 API): 08번 문서의 실행 흐름을 그대로 따른다.
 *   Skill+Version Load -> Input Schema Validation (실패 시 Run 행조차
 *   만들지 않음) -> Run 저장 -> Execution Engine(Brain) -> Output은 이미
 *   Brain이 검증 -> Run/Step 상태 저장.
 * Run 시작 시 로드한 Skill Version을 그대로 고정해서 사용한다
 * (02번: "Run 시작 시 skill_version_id를 고정").
 */
export async function createAndExecuteRun(
  pool: Pool,
  brainClient: BrainClient,
  context: RequestContext,
  skillId: string,
  input: Record<string, unknown>,
  mode: SkillRunMode = 'run',
) {
  const skill = await skillRepo.getSkill(pool, context.workspaceId, skillId);
  if (!skill) throw new AppError('not_found', `Skill "${skillId}" not found`);

  const version = await skillRepo.getSkillVersion(pool, skillId, skill.currentVersion);
  if (!version) throw new AppError('not_found', `Version ${skill.currentVersion} not found for skill "${skillId}"`);

  const inputErrors = validateAgainstJsonSchema(version.spec.inputSchema, input);
  if (inputErrors.length > 0) {
    throw new AppError('validation_error', 'Run input failed inputSchema validation', { errors: inputErrors });
  }

  const run = await runRepo.createSkillRun(pool, {
    workspaceId: context.workspaceId,
    skillId,
    skillVersionId: version.id,
    mode,
    input,
    requestId: context.requestId,
    createdBy: context.userId,
  });

  const { childSkills, knowledgeCorpus } = await buildExecutionContext(pool, context, version.spec);
  const timeoutMsOverride = version.spec.runtime.timeoutSec * 1000 + NETWORK_OVERHEAD_MS;
  const result = await brainClient.executeSkillRun(
    context,
    { spec: version.spec, input, childSkills, knowledgeCorpus },
    timeoutMsOverride,
  );

  return applyRunResult(pool, context, run.id, mode, result);
}

export async function getSkillRun(pool: Pool, context: RequestContext, runId: string) {
  const run = await runRepo.getSkillRun(pool, context.workspaceId, runId);
  if (!run) throw new AppError('not_found', `Skill Run "${runId}" not found`);
  const steps = await runRepo.listRunSteps(pool, runId);
  const childRuns = await runRepo.listChildRuns(pool, runId);
  return { run, steps, childRuns };
}

/**
 * `POST /skill-runs/:id/approve` (05번 6.): resumes Execution from the
 * paused Step, now treated as approved. Reconstructs prior Step outputs
 * from what was already persisted rather than re-running anything.
 */
export async function approveRun(pool: Pool, brainClient: BrainClient, context: RequestContext, runId: string) {
  const run = await runRepo.getSkillRun(pool, context.workspaceId, runId);
  if (!run) throw new AppError('not_found', `Skill Run "${runId}" not found`);
  if (run.status !== 'waiting_approval') {
    throw new AppError('validation_error', `Run "${runId}" is not waiting for approval (status: ${run.status})`);
  }
  const pendingApproval = runRepo.extractPendingApproval(run);
  if (!pendingApproval) {
    throw new AppError('internal_error', `Run "${runId}" is waiting_approval but has no recorded pending step`);
  }

  const version = await skillRepo.getSkillVersionById(pool, run.skillVersionId);
  if (!version) throw new AppError('internal_error', `Pinned Version for Run "${runId}" no longer exists`);

  const priorStepOutputs = await runRepo.getCompletedStepOutputs(pool, runId);
  const { childSkills, knowledgeCorpus } = await buildExecutionContext(pool, context, version.spec);
  const timeoutMsOverride = version.spec.runtime.timeoutSec * 1000 + NETWORK_OVERHEAD_MS;

  const result = await brainClient.executeSkillRun(
    context,
    {
      spec: version.spec,
      input: run.input,
      childSkills,
      knowledgeCorpus,
      resumeFromStepId: pendingApproval.stepId,
      priorStepOutputs,
      approvedStepId: pendingApproval.stepId,
    },
    timeoutMsOverride,
  );

  return applyRunResult(pool, context, runId, run.mode, result);
}

/** `POST /skill-runs/:id/reject` (05번 6.): ends the Run WITHOUT calling Brain again — the paused Tool call never happens. */
export async function rejectRun(pool: Pool, context: RequestContext, runId: string) {
  const run = await runRepo.getSkillRun(pool, context.workspaceId, runId);
  if (!run) throw new AppError('not_found', `Skill Run "${runId}" not found`);
  if (run.status !== 'waiting_approval') {
    throw new AppError('validation_error', `Run "${runId}" is not waiting for approval (status: ${run.status})`);
  }
  const pendingApproval = runRepo.extractPendingApproval(run);
  const updated = await runRepo.markRunTerminal(pool, runId, 'failed', {
    message: `Rejected by user at step '${pendingApproval?.stepId ?? 'unknown'}'`,
  });
  const steps = await runRepo.listRunSteps(pool, runId);
  return { run: updated, steps };
}

/**
 * `POST /skill-runs/:id/cancel` (05번 7.).
 *
 * Phase 6 scoping decision: Execution is still synchronous within one
 * HTTP call to Brain (Streaming/async job queue is explicitly deferred —
 * see README). The only genuinely interruptible state is `waiting_approval`
 * (execution is truly paused, nothing is running). A Run whose status is
 * `running` cannot be live-cancelled yet — that needs an async job
 * architecture this phase does not build; the error says so rather than
 * silently pretending to cancel it. A Run already in a terminal state
 * cannot be cancelled either (05번: "이미 완료된 Run은 취소 불가").
 */
export async function cancelRun(pool: Pool, context: RequestContext, runId: string) {
  const run = await runRepo.getSkillRun(pool, context.workspaceId, runId);
  if (!run) throw new AppError('not_found', `Skill Run "${runId}" not found`);

  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    throw new AppError('validation_error', `Run "${runId}" already reached a terminal state (${run.status}) and cannot be cancelled`);
  }
  if (run.status === 'running' || run.status === 'queued') {
    throw new AppError(
      'validation_error',
      `Run "${runId}" is currently executing synchronously — live cancellation requires an async job ` +
        'architecture not yet implemented (Phase 6 scoping decision). It can only be cancelled while waiting_approval.',
    );
  }

  const updated = await runRepo.markRunTerminal(pool, runId, 'cancelled', null);
  const steps = await runRepo.listRunSteps(pool, runId);
  return { run: updated, steps };
}
