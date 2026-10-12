"""Pydantic models for Skill Export (Phase 9) — mirrors contracts/portable-skill.*
and contracts/export.ts. Keep all three in sync (contract tests assert it).

PortableSkill models are built with ONLY the fields that exist and dumped with
`exclude_unset=True` (see `dump_portable`), so optional fields are simply
absent from the output instead of `null`, and explicit nulls inside user data
(e.g. a usage example whose input is null) are preserved.
"""
from __future__ import annotations

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# PortableSkill (10번 §3 + Phase 9 확정 결정 #4/#10)
# ---------------------------------------------------------------------------

PortableSkillType = Literal["prompt", "knowledge", "tool", "workflow", "composite"]
PortableStepKind = Literal["llm", "tool", "knowledge", "skill", "transform", "condition"]
PortableErrorAction = Literal["fail", "retry", "skip", "fallback"]
PortableToolProtocol = Literal["builtin", "mcp"]
PortableCapabilityId = Literal[
    "web-search",
    "image-generation",
    "code-execution",
    "data-analysis",
    "file-analysis",
    "knowledge-search",
    "mcp",
]

# SkillSpec capability flag -> PortableCapability id (canonical order).
CAPABILITY_IDS: tuple[tuple[str, str], ...] = (
    ("webSearch", "web-search"),
    ("imageGeneration", "image-generation"),
    ("codeExecution", "code-execution"),
    ("dataAnalysis", "data-analysis"),
    ("fileAnalysis", "file-analysis"),
    ("knowledgeSearch", "knowledge-search"),
    ("mcp", "mcp"),
)


class PortableErrorPolicy(_Strict):
    action: PortableErrorAction
    retryCount: Optional[int] = None
    fallbackStepId: Optional[str] = None


class PortableStep(_Strict):
    id: str
    name: str
    kind: PortableStepKind
    ref: Optional[str] = None
    input: Optional[dict[str, Any]] = None
    outputKey: Optional[str] = None
    condition: Optional[str] = None
    requiresApproval: Optional[bool] = None
    onError: Optional[PortableErrorPolicy] = None


class PortableDependency(_Strict):
    ref: str


class PortableCapability(_Strict):
    id: PortableCapabilityId


class PortableToolRequirement(_Strict):
    id: str
    description: str
    protocol: PortableToolProtocol
    inputSchema: dict[str, Any]
    outputSchema: dict[str, Any]


class PortableKnowledgeDocument(_Strict):
    ref: str
    fileName: str
    mimeType: str
    included: bool
    path: Optional[str] = None
    contentHash: Optional[str] = None


class PortableKnowledge(_Strict):
    scope: Literal["workspace", "selected"]
    documents: list[PortableKnowledgeDocument]


class PortableExample(_Strict):
    description: Optional[str] = None
    input: Any = None


class PortableRuntimeRequirements(_Strict):
    requiresLLM: bool
    requiresTools: bool
    requiresMcp: bool
    requiresKnowledge: bool
    requiresCodeExecution: bool
    requiresApproval: bool
    requiresNestedSkill: bool


class PortableRuntimeLimits(_Strict):
    # int|float (not float): an integer 30 must stay `30`, never become `30.0`.
    timeoutSec: Optional[Union[int, float]] = None
    retryCount: Optional[int] = None
    maxToolCalls: Optional[int] = None
    maxNestedSkillDepth: Optional[int] = None


class PortableSource(_Strict):
    skillId: str
    skillVersion: int


class PortableSkill(_Strict):
    formatVersion: Literal["1.0"] = "1.0"

    name: str
    description: str
    objective: str
    instructions: list[str]
    guardrails: list[str]
    skillType: PortableSkillType

    inputContract: dict[str, Any]
    outputContract: dict[str, Any]

    workflow: list[PortableStep]
    outputMapping: Optional[dict[str, Any]] = None

    dependencies: list[PortableDependency]

    requiredCapabilities: list[PortableCapability]
    requiredTools: list[PortableToolRequirement]
    knowledge: list[PortableKnowledge]

    examples: list[PortableExample]

    runtimeRequirements: PortableRuntimeRequirements
    runtimeLimits: PortableRuntimeLimits

    source: Optional[PortableSource] = None
    sourceSpec: Optional[dict[str, Any]] = None


def dump_portable(skill: PortableSkill) -> dict[str, Any]:
    return skill.model_dump(mode="json", exclude_unset=True)


# ---------------------------------------------------------------------------
# Target Profile (10번 §7 + Phase 9 확정 결정 #4/#5)
# ---------------------------------------------------------------------------


class WorkflowSemantics(_Strict):
    sequentialSteps: bool
    condition: bool
    retry: bool
    fallback: bool
    skip: bool
    fail: bool
    inputMapping: bool
    outputMapping: bool


class RuntimeLimitSupport(_Strict):
    timeoutSec: bool
    retryCount: bool
    maxToolCalls: bool
    maxNestedSkillDepth: bool


class ProfileCapabilities(_Strict):
    llm: bool
    instructions: bool
    structuredInput: bool
    structuredOutput: bool
    tools: bool
    mcp: bool
    knowledge: bool
    codeExecution: bool
    workflow: bool
    nestedSkill: bool
    approval: bool
    workflowSemantics: WorkflowSemantics
    runtimeLimits: RuntimeLimitSupport
    supportedCapabilities: list[str] = Field(default_factory=list)
    # Target-specific explanation appended to a non-supported check (keyed by check id).
    notes: dict[str, str] = Field(default_factory=dict)


class ExportTargetProfile(_Strict):
    target: str
    format: str
    displayName: str
    # True for lossless carriers (Portable Package, Raw SkillSpec): they DECLARE every
    # requirement in machine-readable form and execute nothing, so a declared tool/MCP
    # requirement is "carried", not "provided".
    declarative: bool
    capabilities: ProfileCapabilities


class ExportFormatDescriptor(_Strict):
    id: str
    displayName: str
    contentType: str
    # Target Optimized: an `unsupported` compatibility blocks the export (generic formats only warn).
    targetOptimized: bool
    # What the format can actually honor (the effective options).
    embedsKnowledge: bool
    embedsChildSkills: bool
    embedsSourceSpec: bool
    # false = the format is supported (it has a Profile) but no Adapter is registered yet.
    adapterAvailable: bool


class ExportTargetDescriptor(_Strict):
    id: str
    displayName: str
    formats: list[ExportFormatDescriptor]


class ExportTargetsResponse(_Strict):
    targets: list[ExportTargetDescriptor]


# ---------------------------------------------------------------------------
# Compatibility (10번 §8; canonical values are lowercase — 결정 #11)
# ---------------------------------------------------------------------------

CompatibilityLevel = Literal["full", "partial", "unsupported", "blocked"]
CompatibilityStatus = Literal["supported", "partial", "unsupported"]


class CompatibilityCheck(_Strict):
    id: str
    label: str
    status: CompatibilityStatus
    affectsLevel: bool
    reasons: list[str]


class CompatibilityWarning(_Strict):
    code: str
    message: str
    checkId: str


class UnsupportedCapability(_Strict):
    id: str
    label: str
    status: CompatibilityStatus


class KnowledgeSummary(_Strict):
    documents: int
    included: int
    workspaceScope: bool


class CompatibilitySummary(_Strict):
    # Tools the Skill needs that must come from an MCP server on the Target.
    requiredMcp: list[str]
    knowledge: KnowledgeSummary
    # Level-affecting checks the Target does not fully support.
    unsupportedCapabilities: list[UnsupportedCapability]


class CompatibilityResult(_Strict):
    target: str
    format: str
    # `blocked` (not produced by the Analyzer itself): the export cannot run right now
    # (secret detected, knowledge not exportable). See `blockers` on the response.
    level: CompatibilityLevel
    checks: list[CompatibilityCheck]
    warnings: list[CompatibilityWarning]
    manualSteps: list[str]
    summary: CompatibilitySummary


# ---------------------------------------------------------------------------
# Manifest (10번 §12 — Stable Metadata only; no timestamps, 결정 #9)
# ---------------------------------------------------------------------------

class EffectiveOptions(_Strict):
    includeKnowledge: bool
    includeChildSkills: bool
    includeSourceSpec: bool


class ManifestRequirements(_Strict):
    llm: bool
    tools: list[str]
    mcp: bool
    knowledge: bool
    codeExecution: bool
    approval: bool
    nestedSkill: bool


class ManifestSkill(_Strict):
    # Original display name (may be non-ASCII). Archive paths never use it.
    displayName: str
    # ASCII-safe root folder inside a ZIP; absent for single-file formats.
    archivePath: Optional[str] = None
    version: int
    skillType: str
    contentHash: str


class ManifestExport(_Strict):
    target: str
    format: str
    options: EffectiveOptions


class ManifestDependency(_Strict):
    # Child display name (may be non-ASCII); `path` below is its ASCII-safe archive folder.
    displayName: str
    version: int
    contentHash: str
    included: bool
    path: Optional[str] = None


class ManifestKnowledgeDocument(_Strict):
    fileName: str
    mimeType: str
    included: bool
    path: Optional[str] = None
    contentHash: Optional[str] = None


class ManifestFile(_Strict):
    path: str
    sha256: str
    bytes: int


class Manifest(_Strict):
    formatVersion: Literal["1.0"] = "1.0"
    skill: ManifestSkill
    export: ManifestExport
    requirements: ManifestRequirements
    dependencies: dict[str, ManifestDependency]
    knowledge: dict[str, ManifestKnowledgeDocument]
    files: list[ManifestFile]


def dump_manifest(manifest: Manifest) -> dict[str, Any]:
    """Optional `path`/`contentHash` are omitted (not null) so the manifest
    mirrors the exact file contract regardless of which fields were set."""
    return manifest.model_dump(mode="json", exclude_none=True)


# ---------------------------------------------------------------------------
# Compile request / response (internal BFF <-> Brain)
# ---------------------------------------------------------------------------


class ChildSkillInput(BaseModel):
    skillId: str
    name: str
    version: int
    spec: dict[str, Any]


class DocumentInput(BaseModel):
    documentId: str
    fileName: str
    mimeType: str
    content: Optional[str] = None


class ExportOptions(BaseModel):
    target: str
    format: str
    includeKnowledge: bool = False
    includeChildSkills: bool = False
    includeSourceSpec: bool = False


class ExportCompileRequest(BaseModel):
    skillId: str
    version: int
    spec: dict[str, Any]
    children: list[ChildSkillInput] = Field(default_factory=list)
    documents: list[DocumentInput] = Field(default_factory=list)
    options: ExportOptions
    dryRun: bool = False


class SanitizerFindingOut(BaseModel):
    path: str
    category: str


class ExportBlocker(BaseModel):
    code: Literal["EXPORT_SECRET_DETECTED", "KNOWLEDGE_EXPORT_FORBIDDEN"]
    message: str
    # Only for EXPORT_SECRET_DETECTED: where + what kind, never the value.
    findings: list[SanitizerFindingOut] = Field(default_factory=list)


class ExportFile(BaseModel):
    path: str
    content: str


class ExportCompileResponse(BaseModel):
    compatibility: CompatibilityResult
    effectiveOptions: EffectiveOptions
    blockers: list[ExportBlocker] = Field(default_factory=list)
    manifest: Optional[Manifest] = None
    files: list[ExportFile] = Field(default_factory=list)
    packageRoot: Optional[str] = None
    filename: Optional[str] = None
    contentType: Optional[str] = None
    contentHash: Optional[str] = None
