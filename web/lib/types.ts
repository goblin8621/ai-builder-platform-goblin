/**
 * UI-local type definitions. Deliberately NOT importing from
 * `contracts/*.ts` directly — the web app stays a standalone Next.js
 * project (its own bundler/module resolution) rather than reaching across
 * package boundaries, at the cost of light duplication with the BFF/Brain
 * contract types. If this duplication becomes painful, revisit with a
 * shared `contracts` package (npm workspaces / TS project references) —
 * already flagged as a Phase 4 design note in the BFF codebase.
 */

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
  type: 'llm' | 'tool' | 'knowledge' | 'skill' | 'transform' | 'condition';
  refId?: string;
  inputMap?: Record<string, unknown>;
  outputKey?: string;
  condition?: string;
  approvalRequired?: boolean;
  onError?: {
    action: 'fail' | 'retry' | 'skip' | 'fallback';
    retryCount?: number;
    fallbackStepId?: string;
  };
};

export type SkillSpecV1 = {
  schemaVersion: '1.0';
  name: string;
  description: string;
  skillType: 'prompt' | 'knowledge' | 'tool' | 'workflow' | 'composite';
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  instructions: { objective: string; rules: string[] };
  model: { mode: 'user' | 'recommended' | 'fixed'; modelId: string | null; allowUserOverride: boolean };
  capabilities: CapabilityFlags;
  knowledge: { mode: 'none' | 'workspace' | 'selected'; documentIds: string[] };
  execution: { steps: SkillStep[]; outputMap?: Record<string, unknown> };
  runtime: { timeoutSec: number; retryCount: number; maxToolCalls: number; maxNestedSkillDepth: number };
  guardrails: string[];
  usageExamples: { description?: string; input: unknown }[];
  metadata: { category: string; tags: string[] };
};

export type SkillRecord = {
  id: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  description: string;
  skillType: string;
  status: 'draft' | 'active' | 'archived';
  visibility: 'private';
  currentVersion: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillVersionRecord = {
  id: string;
  skillId: string;
  version: number;
  spec: SkillSpecV1;
  changeSource: 'create' | 'ai_refine' | 'manual' | 'restore' | 'migration';
  changeSummary: string | null;
  createdBy: string;
  createdAt: string;
};

export type SkillRunStepRecord = {
  id: string;
  runId: string;
  stepId: string;
  stepType: string;
  status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'skipped';
  attempt: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type SkillRunRecord = {
  id: string;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
  parentRunId: string | null;
  requestId: string | null;
  mode: 'run' | 'preview';
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  createdBy: string;
  createdAt: string;
};

export type ModelDescriptor = { modelId: string; displayName: string; provider: string };
export type ToolDescriptor = {
  toolId: string;
  displayName: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};

// ---------- Documents ----------

export type DocumentRecord = {
  id: string;
  workspaceId: string;
  fileName: string;
  mimeType: string;
  storageKey: string;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  /** Admin-controlled, fail-closed (default false). The BFF re-verifies it on every Export. */
  exportAllowed: boolean;
  createdBy: string;
  createdAt: string;
};

// ---------- Skill Export (mirror of contracts/export.ts, kept dependency-free like the rest of this file) ----------

export type CompatibilityLevel = 'full' | 'partial' | 'unsupported' | 'blocked';
export type CompatibilityStatus = 'supported' | 'partial' | 'unsupported';

export type CompatibilityCheck = {
  id: string;
  label: string;
  status: CompatibilityStatus;
  affectsLevel: boolean;
  reasons: string[];
};

export type CompatibilityWarning = { code: string; message: string; checkId: string };

export type UnsupportedCapability = { id: string; label: string; status: CompatibilityStatus };

export type CompatibilitySummary = {
  requiredMcp: string[];
  knowledge: { documents: number; included: number; workspaceScope: boolean };
  unsupportedCapabilities: UnsupportedCapability[];
};

export type CompatibilityResult = {
  target: string;
  format: string;
  level: CompatibilityLevel;
  checks: CompatibilityCheck[];
  warnings: CompatibilityWarning[];
  manualSteps: string[];
  summary: CompatibilitySummary;
};

export type ExportBlocker = {
  code: 'EXPORT_SECRET_DETECTED' | 'KNOWLEDGE_EXPORT_FORBIDDEN';
  message: string;
  findings: { path: string; category: string }[];
};

export type EffectiveExportOptions = {
  includeKnowledge: boolean;
  includeChildSkills: boolean;
  includeSourceSpec: boolean;
};

export type ExportCompatibilityResponse = {
  compatibility: CompatibilityResult;
  effectiveOptions: EffectiveExportOptions;
  blockers: ExportBlocker[];
  lock: {
    skill: { displayName: string; archivePath?: string; version: number; skillType: string; contentHash: string };
    dependencies: Record<string, { displayName: string; version: number; contentHash: string; included: boolean; path?: string }>;
    knowledge: Record<string, { fileName: string; mimeType: string; included: boolean; path?: string; contentHash?: string }>;
  } | null;
};

export type ExportFormatDescriptor = {
  id: string;
  displayName: string;
  contentType: string;
  targetOptimized: boolean;
  embedsKnowledge: boolean;
  embedsChildSkills: boolean;
  embedsSourceSpec: boolean;
  adapterAvailable: boolean;
};

export type ExportTargetDescriptor = { id: string; displayName: string; formats: ExportFormatDescriptor[] };

export type ExportTargetsResponse = { targets: ExportTargetDescriptor[] };

export type ExportRequestBody = {
  version: number;
  target: string;
  format: string;
  includeKnowledge?: boolean;
  includeChildSkills?: boolean;
  includeSourceSpec?: boolean;
  acknowledgeWarnings?: boolean;
};

export function emptySpec(overrides: Partial<SkillSpecV1> = {}): SkillSpecV1 {
  return {
    schemaVersion: '1.0',
    name: '',
    description: '',
    skillType: 'prompt',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
    instructions: { objective: '', rules: [] },
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
    execution: { steps: [{ id: 'step-1', name: 'Step 1', type: 'llm' }] },
    runtime: { timeoutSec: 30, retryCount: 1, maxToolCalls: 0, maxNestedSkillDepth: 0 },
    guardrails: [],
    usageExamples: [],
    metadata: { category: 'general', tags: [] },
    ...overrides,
  };
}
