/**
 * PortableSkill v1 TypeScript type (10번 Skill Export / Portable Skill 설계 §3).
 *
 * TYPED MIRROR of contracts/portable-skill.schema.json (same discipline as
 * skill-spec.ts): the JSON Schema file is the single validator; Brain
 * (brain/app/exports/models.py, Pydantic) produces this shape and BFF only
 * transports it. Provider names never appear here — Target differences are
 * Target Profile + Adapter concerns (10번 §7).
 *
 * Phase 9 확정 결정:
 * - `guardrails` and `runtimeLimits` are part of the contract. Limits are
 *   DECLARED values, never assumed enforceable on a Target.
 * - Internal ids are never used: Child Skills are `child:<slug>` and
 *   Documents are `doc:<slug>` (Package-local aliases). Internal ids appear
 *   only in the optional `source`/`sourceSpec`, i.e. only when the Export was
 *   requested with includeSourceSpec.
 * - No timestamps / random ids anywhere — deterministic Export.
 */
import type { SkillSpecV1 } from './skill-spec.js';

export type PortableSkillType = 'prompt' | 'knowledge' | 'tool' | 'workflow' | 'composite';
export type PortableStepKind = 'llm' | 'tool' | 'knowledge' | 'skill' | 'transform' | 'condition';
export type PortableErrorAction = 'fail' | 'retry' | 'skip' | 'fallback';
export type PortableToolProtocol = 'builtin' | 'mcp';

export type PortableCapabilityId =
  | 'web-search'
  | 'image-generation'
  | 'code-execution'
  | 'data-analysis'
  | 'file-analysis'
  | 'knowledge-search'
  | 'mcp';

export type PortableStep = {
  id: string;
  name: string;
  kind: PortableStepKind;
  /** Tool id, or `child:<slug>` for kind === 'skill'. */
  ref?: string;
  /** Same `{ "$ref": "input..." | "steps.<id>.output..." }` / Static Value grammar as SkillSpec inputMap. */
  input?: Record<string, unknown>;
  outputKey?: string;
  condition?: string;
  requiresApproval?: boolean;
  onError?: { action: PortableErrorAction; retryCount?: number; fallbackStepId?: string };
};

export type PortableToolRequirement = {
  id: string;
  description: string;
  protocol: PortableToolProtocol;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};

export type PortableKnowledgeDocument = {
  /** `doc:<slug>` Package-local alias. */
  ref: string;
  fileName: string;
  mimeType: string;
  included: boolean;
  /** Present only when included (e.g. `references/report.csv`). */
  path?: string;
  /** sha256 of the newline-normalized UTF-8 content. Present only when included. */
  contentHash?: string;
};

export type PortableKnowledge = {
  scope: 'workspace' | 'selected';
  documents: PortableKnowledgeDocument[];
};

export type PortableExample = { description?: string; input: unknown };

export type PortableRuntimeRequirements = {
  requiresLLM: boolean;
  requiresTools: boolean;
  requiresMcp: boolean;
  requiresKnowledge: boolean;
  requiresCodeExecution: boolean;
  requiresApproval: boolean;
  requiresNestedSkill: boolean;
};

export type PortableRuntimeLimits = {
  timeoutSec?: number;
  retryCount?: number;
  maxToolCalls?: number;
  maxNestedSkillDepth?: number;
};

export type PortableSkill = {
  formatVersion: '1.0';

  name: string;
  description: string;
  objective: string;
  instructions: string[];
  guardrails: string[];
  skillType: PortableSkillType;

  inputContract: Record<string, unknown>;
  outputContract: Record<string, unknown>;

  workflow: PortableStep[];
  outputMapping?: Record<string, unknown>;

  dependencies: { ref: string }[];

  requiredCapabilities: { id: PortableCapabilityId }[];
  requiredTools: PortableToolRequirement[];
  knowledge: PortableKnowledge[];

  examples: PortableExample[];

  runtimeRequirements: PortableRuntimeRequirements;
  runtimeLimits: PortableRuntimeLimits;

  /** Only when includeSourceSpec. */
  source?: { skillId: string; skillVersion: number };
  /** Only when includeSourceSpec. */
  sourceSpec?: SkillSpecV1;
};
