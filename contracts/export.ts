/**
 * Skill Export API / Compatibility contract (10번 §7, §8, §13, §14).
 *
 * Canonical enum values are LOWERCASE everywhere (API, Portable Contract,
 * Brain models) — `full | partial | unsupported | blocked`. Only the UI
 * upper-cases them for display (Phase 9 확정 결정 #11).
 *
 * The public API names the Target explicitly — `{ target: 'claude', format:
 * 'skill-package' }`, `{ target: 'generic', format: 'markdown' }` — instead of
 * an abstract `format: 'target'`. Brain's Adapter registry selects the
 * implementation by (target, format).
 *
 * Brain produces every type here (brain/app/exports/models.py mirrors them);
 * BFF resolves Version / Child Skills / Documents / permissions, calls Brain,
 * and does the packaging (ZIP) + download response.
 */
import type { SkillSpecV1 } from './skill-spec.js';
import type { PortableSkill } from './portable-skill.js';

/** Export Target id, e.g. `claude`, `generic`. Open set: a new Target is a Profile + an Adapter in Brain. */
export type ExportTargetId = string;
/** Format a Target offers, e.g. `skill-package` (claude); `portable-package` | `markdown` | `raw-spec` (generic). */
export type ExportFormatId = string;

/**
 * `blocked` is not produced by the Compatibility Analyzer: the export cannot
 * run right now (a secret was detected, or Knowledge documents may not be
 * exported). The reasons are in `blockers`.
 */
export type CompatibilityLevel = 'full' | 'partial' | 'unsupported' | 'blocked';
export type CompatibilityStatus = 'supported' | 'partial' | 'unsupported';

export type CompatibilityCheck = {
  /** e.g. `llm`, `tools`, `mcp`, `knowledge`, `workflow.retry`, `nestedApproval`, `limits.timeoutSec` */
  id: string;
  label: string;
  status: CompatibilityStatus;
  /** Advisory checks (e.g. timeout not enforceable) are reported but never change `level`. */
  affectsLevel: boolean;
  reasons: string[];
};

export type CompatibilityWarning = { code: string; message: string; checkId: string };

export type UnsupportedCapability = { id: string; label: string; status: CompatibilityStatus };

export type CompatibilitySummary = {
  /** Tools the Skill needs that must come from an MCP server on the Target. */
  requiredMcp: string[];
  knowledge: { documents: number; included: number; workspaceScope: boolean };
  /** Level-affecting checks the Target does not fully support. */
  unsupportedCapabilities: UnsupportedCapability[];
};

export type CompatibilityResult = {
  target: ExportTargetId;
  format: ExportFormatId;
  level: CompatibilityLevel;
  checks: CompatibilityCheck[];
  warnings: CompatibilityWarning[];
  /** Concrete manual steps needed to reproduce the Skill on the Target (PARTIAL → 필요한 수동 설정 명시). */
  manualSteps: string[];
  summary: CompatibilitySummary;
};

export type EffectiveExportOptions = {
  includeKnowledge: boolean;
  includeChildSkills: boolean;
  includeSourceSpec: boolean;
};

/** Never contains the secret value itself — only where and what kind. */
export type SanitizerFinding = { path: string; category: string };

/**
 * Why an export cannot run. `KNOWLEDGE_EXPORT_FORBIDDEN` deliberately carries
 * no document names/ids/counts — a blocker must not expose metadata of
 * documents the caller may not export.
 */
export type ExportBlocker = {
  code: 'EXPORT_SECRET_DETECTED' | 'KNOWLEDGE_EXPORT_FORBIDDEN';
  message: string;
  /** Only for EXPORT_SECRET_DETECTED. */
  findings: SanitizerFinding[];
};

// ---------- Target Profile (10번 §7, extended per Phase 9 결정 #4/#5) ----------

export type WorkflowSemantics = {
  sequentialSteps: boolean;
  condition: boolean;
  retry: boolean;
  fallback: boolean;
  skip: boolean;
  fail: boolean;
  inputMapping: boolean;
  outputMapping: boolean;
};

export type RuntimeLimitSupport = {
  timeoutSec: boolean;
  retryCount: boolean;
  maxToolCalls: boolean;
  maxNestedSkillDepth: boolean;
};

export type ProfileCapabilities = {
  llm: boolean;
  instructions: boolean;
  structuredInput: boolean;
  structuredOutput: boolean;
  tools: boolean;
  mcp: boolean;
  knowledge: boolean;
  codeExecution: boolean;
  /** Target can represent a multi-step workflow at all. */
  workflow: boolean;
  nestedSkill: boolean;
  approval: boolean;
  /** Fine-grained: what the Target actually ENFORCES, not merely describes. */
  workflowSemantics: WorkflowSemantics;
  runtimeLimits: RuntimeLimitSupport;
  /** Capability ids with no dedicated flag above (web-search, image-generation, file-analysis). */
  supportedCapabilities: string[];
  /** Target-specific explanation appended to a non-supported check, keyed by check id. */
  notes: Record<string, string>;
};

export type ExportTargetProfile = {
  target: ExportTargetId;
  format: ExportFormatId;
  displayName: string;
  /** Lossless carriers (Portable Package, Raw SkillSpec) DECLARE requirements; they execute nothing. */
  declarative: boolean;
  capabilities: ProfileCapabilities;
};

export type ExportFormatDescriptor = {
  id: ExportFormatId;
  displayName: string;
  contentType: string;
  /** Target Optimized: an `unsupported` compatibility blocks the export (generic formats only warn). */
  targetOptimized: boolean;
  /** What the format can actually honor (the effective options). */
  embedsKnowledge: boolean;
  embedsChildSkills: boolean;
  embedsSourceSpec: boolean;
  /** false = supported (has a Profile) but no Adapter is registered, so it cannot export yet. */
  adapterAvailable: boolean;
};

export type ExportTargetDescriptor = {
  id: ExportTargetId;
  displayName: string;
  formats: ExportFormatDescriptor[];
};

export type ExportTargetsResponse = { targets: ExportTargetDescriptor[] };

// ---------- Manifest (10번 §12; Stable Metadata only — no timestamps) ----------

export type ManifestRequirements = {
  llm: boolean;
  tools: string[];
  mcp: boolean;
  knowledge: boolean;
  codeExecution: boolean;
  approval: boolean;
  nestedSkill: boolean;
};

export type ManifestDependency = {
  /** Child display name (may be non-ASCII); `path` is its ASCII-safe archive folder. */
  displayName: string;
  /** The Child Version locked at Export time (Dependency Resolution snapshot). */
  version: number;
  contentHash: string;
  included: boolean;
  path?: string;
};

export type ManifestKnowledgeDocument = {
  fileName: string;
  mimeType: string;
  included: boolean;
  path?: string;
  contentHash?: string;
};

export type ManifestFile = { path: string; sha256: string; bytes: number };

export type Manifest = {
  formatVersion: '1.0';
  skill: {
    /** Original display name (may be non-ASCII). Archive paths never use it. */
    displayName: string;
    /** ASCII-safe root folder inside a ZIP; absent for single-file formats. */
    archivePath?: string;
    version: number;
    skillType: string;
    contentHash: string;
  };
  export: {
    target: ExportTargetId;
    format: ExportFormatId;
    options: EffectiveExportOptions;
  };
  requirements: ManifestRequirements;
  dependencies: Record<string, ManifestDependency>;
  knowledge: Record<string, ManifestKnowledgeDocument>;
  /** Every file in the package except manifest.json itself. */
  files: ManifestFile[];
};

// ---------- BFF public API ----------

export type ExportRequestBody = {
  /** REQUIRED — Export is always pinned to an explicit Skill Version (never "latest" implicitly). */
  version: number;
  /** e.g. `claude` | `generic`. Unknown → `EXPORT_TARGET_UNSUPPORTED`. */
  target: ExportTargetId;
  /** e.g. `skill-package` | `markdown`. Not offered by the target → `EXPORT_FORMAT_UNSUPPORTED`. */
  format: ExportFormatId;
  includeKnowledge?: boolean;
  includeChildSkills?: boolean;
  includeSourceSpec?: boolean;
  /** Must be true to export when compatibility is `partial` or `unsupported` (generic formats). */
  acknowledgeWarnings?: boolean;
};

export type ExportCompatibilityResponse = {
  compatibility: CompatibilityResult;
  effectiveOptions: EffectiveExportOptions;
  blockers: ExportBlocker[];
  /** Resolved Dependency / Knowledge snapshot the Export would be built from. Null when blocked. */
  lock: Pick<Manifest, 'skill' | 'dependencies' | 'knowledge'> | null;
};

// ---------- BFF <-> Brain internal ----------

export type ExportChildSkillPayload = { skillId: string; name: string; version: number; spec: SkillSpecV1 };

export type ExportDocumentPayload = {
  documentId: string;
  fileName: string;
  mimeType: string;
  /** Present ONLY when BFF verified workspace ∧ document access ∧ export_allowed and the Export embeds documents. */
  content?: string | null;
};

export type ExportCompileRequestBody = {
  skillId: string;
  version: number;
  spec: SkillSpecV1;
  children: ExportChildSkillPayload[];
  documents: ExportDocumentPayload[];
  options: {
    target: ExportTargetId;
    format: ExportFormatId;
    includeKnowledge: boolean;
    includeChildSkills: boolean;
    includeSourceSpec: boolean;
  };
  /** true → analysis only (Compatibility); secrets are reported in `blockers` instead of raising. */
  dryRun: boolean;
};

export type ExportFile = { path: string; content: string };

export type ExportCompileResponse = {
  compatibility: CompatibilityResult;
  effectiveOptions: EffectiveExportOptions;
  blockers: ExportBlocker[];
  manifest: Manifest | null;
  /** UTF-8 text files, already sorted and newline-normalized by Brain. BFF only packages them. */
  files: ExportFile[];
  /** Folder name inside a ZIP package; null for single-file formats. */
  packageRoot: string | null;
  filename: string | null;
  contentType: string | null;
  /** sha256 over the logical file list (independent of ZIP encoding). */
  contentHash: string | null;
};

export type { PortableSkill };
