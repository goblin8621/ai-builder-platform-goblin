/**
 * Skill Execution Engine contract (08번 문서) — internal BFF <-> Brain
 * request/response shape for `POST /runtime/execute`.
 *
 * Brain executes every Step of an already-validated, already-pinned Skill
 * Spec against an already-validated Run Input and returns the full trace
 * in one response (no Streaming yet — Phase 6 explicitly deferred it, see
 * README). BFF persists this trace into `skill_runs` / `skill_run_steps`,
 * walking `StepResult.childRun` trees for Nested Skill (parent/child Run
 * linkage, 02번).
 *
 * Brain has no database access (06번 역할 분리) — BFF resolves and pins
 * every reachable child Skill Version (up to `maxNestedSkillDepth`) and
 * fetches every in-scope Knowledge chunk BEFORE calling this endpoint,
 * passing them as plain data (`childSkills`, `knowledgeCorpus`).
 */
import type { SkillSpecV1 } from './skill-spec.js';

export type ChildSkillPayload = {
  skillVersionId: string;
  spec: SkillSpecV1;
};

export type KnowledgeChunkPayload = {
  documentId: string;
  chunkIndex: number;
  content: string;
};

export type ExecuteRequestBody = {
  spec: SkillSpecV1;
  input: Record<string, unknown>;
  childSkills: Record<string, ChildSkillPayload>;
  knowledgeCorpus: KnowledgeChunkPayload[];
  /**
   * Human Approval resume (08번 7.): all three set together when resuming
   * a Run that was previously `waiting_approval`; omitted for a fresh Run.
   */
  resumeFromStepId?: string;
  priorStepOutputs?: Record<string, Record<string, unknown>>;
  approvedStepId?: string;
};

export type StepStatus = 'completed' | 'failed' | 'skipped';

export type StepResult = {
  stepId: string;
  stepType: string;
  status: StepStatus;
  attempt: number;
  input: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  error?: string | null;
  /** Present only for stepType === 'skill': the child Run's own full trace (recursive). */
  childRun?: ChildRunTrace | null;
};

export type ChildRunTrace = {
  skillId: string;
  skillVersionId: string;
  status: 'completed' | 'failed';
  output?: Record<string, unknown> | null;
  error?: string | null;
  steps: StepResult[];
};

export type PendingApproval = {
  stepId: string;
  stepType: string;
  input: Record<string, unknown>;
};

export type OutputValidationError = { path: string; message: string };

export type RunResult = {
  status: 'completed' | 'failed' | 'waiting_approval';
  /**
   * Normally only set when status === 'completed'. EXCEPTION: when the
   * failure is specifically Output Schema Validation, `output` still
   * carries the actual (invalid) value produced, so Debug can show what
   * really came out (P8 사용자 결정 #3).
   */
  output?: Record<string, unknown> | null;
  error?: string | null;
  /** Machine-readable code for the (currently few) failure reasons that need
   * one — e.g. "NESTED_SKILL_APPROVAL_NOT_SUPPORTED" (P8 사용자 결정 #4).
   * null/absent for ordinary Step failures, which only have a prose `error`. */
  errorCode?: string | null;
  /** Present only for the Output Schema Validation failure case. */
  outputValidationErrors?: OutputValidationError[] | null;
  steps: StepResult[];
  /** Present only when status === 'waiting_approval' (08번 7.). */
  pendingApproval?: PendingApproval | null;
};
