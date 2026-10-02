import type { Pool } from 'pg';

export type SkillRunStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type SkillRunMode = 'run' | 'preview';
export type SkillStepStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'skipped';

export type SkillRunRecord = {
  id: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
  parentRunId: string | null;
  requestId: string | null;
  mode: SkillRunMode;
  status: SkillRunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  createdBy: string;
  createdAt: string;
};

export type SkillRunStepRecord = {
  id: string;
  runId: string;
  stepId: string;
  stepType: string;
  status: SkillStepStatus;
  attempt: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
};

function toSkillRunRecord(row: any): SkillRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    skillId: row.skill_id,
    skillVersionId: row.skill_version_id,
    parentRunId: row.parent_run_id,
    requestId: row.request_id,
    mode: row.mode,
    status: row.status,
    input: row.input_json,
    output: row.output_json,
    error: row.error_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function toSkillRunStepRecord(row: any): SkillRunStepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    stepType: row.step_type,
    status: row.status,
    attempt: row.attempt,
    input: row.input_json,
    output: row.output_json,
    error: row.error_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export type CreateSkillRunInput = {
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
  mode: SkillRunMode;
  input: Record<string, unknown>;
  requestId: string | null;
  createdBy: string;
  /** Set for a Nested Skill's child Run (02번 parent_run_id). */
  parentRunId?: string | null;
};

/** Creates a `running` Run row with the Skill Version already pinned (02번: "Run 시작 시 skill_version_id를 고정"). */
export async function createSkillRun(pool: Pool, input: CreateSkillRunInput): Promise<SkillRunRecord> {
  const result = await pool.query(
    `INSERT INTO skill_runs
        (workspace_id, skill_id, skill_version_id, parent_run_id, mode, status, input_json, request_id, created_by, started_at)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, now())
     RETURNING *`,
    [
      input.workspaceId,
      input.skillId,
      input.skillVersionId,
      input.parentRunId ?? null,
      input.mode,
      JSON.stringify(input.input),
      input.requestId,
      input.createdBy,
    ],
  );
  return toSkillRunRecord(result.rows[0]);
}

export type CompleteSkillRunInput = {
  runId: string;
  status: 'completed' | 'failed';
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
};

export async function completeSkillRun(pool: Pool, input: CompleteSkillRunInput): Promise<SkillRunRecord> {
  const result = await pool.query(
    `UPDATE skill_runs
        SET status = $1, output_json = $2, error_json = $3, completed_at = now()
      WHERE id = $4
      RETURNING *`,
    [input.status, input.output ? JSON.stringify(input.output) : null, input.error ? JSON.stringify(input.error) : null, input.runId],
  );
  return toSkillRunRecord(result.rows[0]);
}

export type PendingApproval = { stepId: string; stepType: string; input: Record<string, unknown> };

/**
 * Marks a Run as paused for Human Approval (08번 7.) — no completed_at,
 * still "open". `pendingApproval` is stashed in `output_json` (unused
 * while genuinely waiting — no output exists yet) rather than adding a
 * new column, and is overwritten once the Run actually completes.
 */
export async function markRunWaitingApproval(
  pool: Pool,
  runId: string,
  pendingApproval: PendingApproval,
): Promise<SkillRunRecord> {
  const result = await pool.query(
    `UPDATE skill_runs SET status = 'waiting_approval', output_json = $1 WHERE id = $2 RETURNING *`,
    [JSON.stringify({ __pendingApproval: pendingApproval }), runId],
  );
  return toSkillRunRecord(result.rows[0]);
}

export function extractPendingApproval(run: SkillRunRecord): PendingApproval | null {
  const marker = run.output?.['__pendingApproval'];
  return (marker as PendingApproval | undefined) ?? null;
}

/**
 * Reject/Cancel (05번 6./7.): ends a Run without calling Brain again.
 * Clears `output_json` — a rejected/cancelled Run has no real output, and
 * this also removes any `__pendingApproval` marker a prior
 * `markRunWaitingApproval` call left there (02번: 리소스마다 깨끗한 상태).
 */
export async function markRunTerminal(
  pool: Pool,
  runId: string,
  status: 'failed' | 'cancelled',
  error: Record<string, unknown> | null,
): Promise<SkillRunRecord> {
  const result = await pool.query(
    `UPDATE skill_runs SET status = $1, error_json = $2, output_json = NULL, completed_at = now() WHERE id = $3 RETURNING *`,
    [status, error ? JSON.stringify(error) : null, runId],
  );
  return toSkillRunRecord(result.rows[0]);
}

export type InsertRunStepInput = {
  runId: string;
  stepId: string;
  stepType: string;
  status: SkillStepStatus;
  attempt: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
};

export async function insertRunSteps(pool: Pool, steps: InsertRunStepInput[]): Promise<void> {
  for (const step of steps) {
    await pool.query(
      `INSERT INTO skill_run_steps
          (run_id, step_id, step_type, status, attempt, input_json, output_json, error_json, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())`,
      [
        step.runId,
        step.stepId,
        step.stepType,
        step.status,
        step.attempt,
        step.input ? JSON.stringify(step.input) : null,
        step.output ? JSON.stringify(step.output) : null,
        step.error ? JSON.stringify({ message: step.error }) : null,
      ],
    );
  }
}

export async function getSkillRun(pool: Pool, workspaceId: string, runId: string): Promise<SkillRunRecord | null> {
  const result = await pool.query(`SELECT * FROM skill_runs WHERE id = $1 AND workspace_id = $2`, [runId, workspaceId]);
  return result.rows[0] ? toSkillRunRecord(result.rows[0]) : null;
}

export async function listRunSteps(pool: Pool, runId: string): Promise<SkillRunStepRecord[]> {
  const result = await pool.query(
    `SELECT * FROM skill_run_steps WHERE run_id = $1 ORDER BY started_at ASC, attempt ASC`,
    [runId],
  );
  return result.rows.map(toSkillRunStepRecord);
}

/**
 * Reconstructs the `step_outputs` map an in-progress Run had accumulated
 * before it paused for Approval — one 'completed' row per step id is
 * expected (a step only ever reaches 'completed' once; earlier failed
 * retry attempts are ignored here). Used to resume Execution in Brain
 * without re-running already-completed Steps.
 */
export async function getCompletedStepOutputs(pool: Pool, runId: string): Promise<Record<string, Record<string, unknown>>> {
  const result = await pool.query(
    `SELECT step_id, output_json FROM skill_run_steps WHERE run_id = $1 AND status = 'completed'`,
    [runId],
  );
  const outputs: Record<string, Record<string, unknown>> = {};
  for (const row of result.rows) {
    outputs[row.step_id] = row.output_json;
  }
  return outputs;
}

/** Nested Skill (02번 Parent/Child Run): direct children of one Run, if any. */
export async function listChildRuns(pool: Pool, parentRunId: string): Promise<SkillRunRecord[]> {
  const result = await pool.query(`SELECT * FROM skill_runs WHERE parent_run_id = $1 ORDER BY created_at ASC`, [
    parentRunId,
  ]);
  return result.rows.map(toSkillRunRecord);
}
