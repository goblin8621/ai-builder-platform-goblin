/**
 * SkillSpec v1 TypeScript type (03. Skill Spec 계약 기준).
 *
 * This is a TYPED MIRROR of contracts/skill-spec.schema.json — it is not
 * itself the validator. Runtime validation always goes through the JSON
 * Schema file (see bff/src/skills/skill-spec-validator.ts and, on the
 * Python side, brain/app/skills/validator.py), so TS and Python can never
 * silently drift: both point at the same schema.json.
 */

export type SkillType = 'prompt' | 'knowledge' | 'tool' | 'workflow' | 'composite';

export type SkillStepType = 'llm' | 'tool' | 'knowledge' | 'skill' | 'transform' | 'condition';

export type StepErrorAction = 'fail' | 'retry' | 'skip' | 'fallback';

/**
 * Mapping Resolver contract (08번, Phase 5 설계 결정).
 *
 * A `MappingRef` is the ONLY form treated as a reference:
 *   { "$ref": "input.<path>" }              -> Run Input
 *   { "$ref": "steps.<stepId>.output.<path>" } -> a previous Step's output
 * Any other JSON value (including a plain string that merely LOOKS like a
 * path, e.g. "input.text") is a Static Value used literally — this is why
 * the reference form must be the explicit `{ "$ref": ... }` object rather
 * than a bare string, unlike the earlier (superseded) `"steps.x.output.y"`
 * string convention.
 *
 * No arbitrary expression evaluation is ever performed — only this fixed
 * `$ref` grammar. Resolution (including "step does not exist" / "step has
 * not executed yet" / "path not found" errors) is implemented once in
 * brain/app/skills/mapping_resolver.py (Brain is the only place that
 * actually executes Steps); this type exists so BFF's static semantic
 * validation (bff/src/skills/skill-spec-validator.ts) can recognize the
 * same shape when checking a `$ref`'s step id exists and, for `inputMap`,
 * appears earlier in `execution.steps`.
 */
export type MappingRef = { $ref: string };

export type MappingValue = MappingRef | unknown;

export type MappingTable = Record<string, MappingValue>;

export type CapabilityFlags = {
  webSearch: boolean;
  imageGeneration: boolean;
  codeExecution: boolean;
  dataAnalysis: boolean;
  fileAnalysis: boolean;
  knowledgeSearch: boolean;
  mcp: boolean;
};

export type SkillStep = {
  id: string;
  name: string;
  type: SkillStepType;
  refId?: string;
  inputMap?: MappingTable;
  outputKey?: string;
  condition?: string;
  approvalRequired?: boolean;
  onError?: {
    action: StepErrorAction;
    retryCount?: number;
    fallbackStepId?: string;
  };
};

export type SkillSpecV1 = {
  schemaVersion: '1.0';
  name: string;
  description: string;
  skillType: SkillType;

  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;

  instructions: {
    objective: string;
    rules: string[];
  };

  model: {
    mode: 'user' | 'recommended' | 'fixed';
    modelId: string | null;
    allowUserOverride: boolean;
  };

  capabilities: CapabilityFlags;

  knowledge: {
    mode: 'none' | 'workspace' | 'selected';
    documentIds: string[];
  };

  execution: {
    steps: SkillStep[];
    /**
     * Explicit final Run Output mapping (Phase 5 설계 결정: condition/
     * fallback/nested skill이 들어가면 마지막 Step이 항상 최종 결과라고
     * 보장할 수 없으므로, "마지막 Step output"을 유일한 규칙으로 두지
     * 않는다). When present, this determines the Run Output — validated
     * against `outputSchema` — instead of the last completed Step's
     * output. Same `$ref`/Static Value grammar as `SkillStep.inputMap`.
     */
    outputMap?: MappingTable;
  };

  runtime: {
    timeoutSec: number;
    retryCount: number;
    maxToolCalls: number;
    maxNestedSkillDepth: number;
  };

  guardrails: string[];

  usageExamples: {
    description?: string;
    input: unknown;
  }[];

  metadata: {
    category: string;
    tags: string[];
  };
};
