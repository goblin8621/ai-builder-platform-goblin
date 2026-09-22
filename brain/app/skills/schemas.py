"""SkillSpec v1 Pydantic model (03. Skill Spec 계약 기준).

This is a TYPED MIRROR of contracts/skill-spec.schema.json — it is not
itself the validator. Runtime validation always goes through the JSON
Schema file (see app/skills/validator.py, and on the TS side
bff/src/skills/skill-spec-validator.ts), so Python and TypeScript can
never silently drift: both point at the same schema.json.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel

SkillType = Literal["prompt", "knowledge", "tool", "workflow", "composite"]
SkillStepType = Literal["llm", "tool", "knowledge", "skill", "transform", "condition"]
StepErrorAction = Literal["fail", "retry", "skip", "fallback"]


class StepErrorPolicy(BaseModel):
    action: StepErrorAction
    retryCount: Optional[int] = None
    fallbackStepId: Optional[str] = None


class SkillStep(BaseModel):
    id: str
    name: str
    type: SkillStepType
    refId: Optional[str] = None
    # Each value is either {"$ref": "input.<path>" | "steps.<stepId>.output.<path>"}
    # or any other JSON value used literally as a Static Value (a plain
    # string is NEVER treated as a reference — only the $ref object form
    # is). See app/skills/mapping_resolver.py.
    inputMap: Optional[dict[str, Any]] = None
    outputKey: Optional[str] = None
    condition: Optional[str] = None
    approvalRequired: Optional[bool] = None
    onError: Optional[StepErrorPolicy] = None


class ModelPolicy(BaseModel):
    mode: Literal["user", "recommended", "fixed"]
    modelId: Optional[str] = None
    allowUserOverride: bool


class CapabilityFlags(BaseModel):
    webSearch: bool
    imageGeneration: bool
    codeExecution: bool
    dataAnalysis: bool
    fileAnalysis: bool
    knowledgeSearch: bool
    mcp: bool


class KnowledgePolicy(BaseModel):
    mode: Literal["none", "workspace", "selected"]
    documentIds: list[str]


class Instructions(BaseModel):
    objective: str
    rules: list[str]


class Execution(BaseModel):
    steps: list[SkillStep]
    # Explicit final Run Output mapping (Phase 5 설계 결정 — see
    # contracts/skill-spec.ts Execution.outputMap). Same $ref/Static Value
    # grammar as SkillStep.inputMap, resolved by app/skills/mapping_resolver.py.
    outputMap: Optional[dict[str, Any]] = None


class RuntimeLimits(BaseModel):
    timeoutSec: float
    retryCount: int
    maxToolCalls: int
    maxNestedSkillDepth: int


class UsageExample(BaseModel):
    description: Optional[str] = None
    input: Any = None


class Metadata(BaseModel):
    category: str
    tags: list[str]


class SkillSpecV1(BaseModel):
    schemaVersion: Literal["1.0"]
    name: str
    description: str
    skillType: SkillType

    inputSchema: dict[str, Any]
    outputSchema: dict[str, Any]

    instructions: Instructions
    model: ModelPolicy
    capabilities: CapabilityFlags
    knowledge: KnowledgePolicy
    execution: Execution
    runtime: RuntimeLimits
    guardrails: list[str]
    usageExamples: list[UsageExample]
    metadata: Metadata
