"""Skill Builder orchestration (04. Skill Builder 설계).

Implements the pipeline from 04번 section 4:

    request -> Builder Prompt -> LLM Structured Output
             -> SkillSpec Schema Validation -> Registry/Capability Validation
             -> repair once on failure -> Draft

Builder never persists anything and never calls a Tool/Skill/MCP for real
(04번 8. 보안) — it only returns a candidate SkillSpec (or a `clarify`
response). The caller (BFF) is responsible for re-running the full
Phase 2/3 validation pipeline again before persisting — this module's
validation exists to give the Builder itself a chance to repair its own
mistakes, not to be the final authority.
"""
from __future__ import annotations

import json
from typing import Any, Literal, Optional

from pydantic import BaseModel

from app.common.capabilities.registry import CapabilityRegistry
from app.common.errors import AppError
from app.common.json_utils import parse_json_object
from app.common.models.interface import ModelClient, ModelCompletionRequest
from app.common.models.static_registry import StaticModelRegistry
from app.common.tools.static_registry import StaticToolRegistry
from app.skills.prompts import build_repair_prompt, build_system_prompt, build_user_prompt
from app.skills.registry_validator import validate_against_registries
from app.skills.validator import validate_skill_spec

_MAX_ATTEMPTS = 2  # 1 initial + 1 repair (04번: "malformed output은 최대 1회 Repair")

_model_registry = StaticModelRegistry()
_tool_registry = StaticToolRegistry()
_capability_registry = CapabilityRegistry()


class SkillSummary(BaseModel):
    id: str
    name: str
    description: str


class DocumentSummary(BaseModel):
    id: str
    fileName: str


class BuilderInput(BaseModel):
    request: str
    currentSpec: Optional[dict[str, Any]] = None
    availableSkills: list[SkillSummary] = []
    availableKnowledge: list[DocumentSummary] = []
    defaults: dict[str, Any] = {}


class BuilderOutput(BaseModel):
    action: Literal["draft", "update", "clarify"]
    message: Optional[str] = None
    changeSummary: Optional[list[str]] = None
    missingFields: Optional[list[str]] = None
    spec: Optional[dict[str, Any]] = None


def _capability_flags_camel() -> dict[str, bool]:
    flags = _capability_registry.supported()
    return {
        "webSearch": flags.web_search,
        "imageGeneration": flags.image_generation,
        "codeExecution": flags.code_execution,
        "dataAnalysis": flags.data_analysis,
        "fileAnalysis": flags.file_analysis,
        "knowledgeSearch": flags.knowledge_search,
        "mcp": flags.mcp,
    }


def _build_context(builder_input: BuilderInput) -> dict[str, Any]:
    return {
        "request": builder_input.request,
        "currentSpec": builder_input.currentSpec,
        "availableModels": [
            {"modelId": m.model_id, "displayName": m.display_name, "provider": m.provider}
            for m in _model_registry.list_available()
        ],
        "availableCapabilities": _capability_flags_camel(),
        "availableTools": [
            {
                "toolId": t.tool_id,
                "displayName": t.display_name,
                "inputSchema": t.input_schema,
                "outputSchema": t.output_schema,
            }
            for t in _tool_registry.list_available()
        ],
        "availableSkills": [s.model_dump() for s in builder_input.availableSkills],
        "availableKnowledge": [d.model_dump() for d in builder_input.availableKnowledge],
        "defaults": builder_input.defaults,
    }


async def _run_pipeline(
    mode: Literal["create", "refine"],
    builder_input: BuilderInput,
    model_client: ModelClient,
    builder_model_id: str,
) -> BuilderOutput:
    context = _build_context(builder_input)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": build_system_prompt(mode)},
        {"role": "user", "content": build_user_prompt(context)},
    ]

    attempts: list[str] = []
    last_errors: list[str] = []

    for _ in range(_MAX_ATTEMPTS):
        result = await model_client.complete(
            ModelCompletionRequest(model_id=builder_model_id, messages=messages)
        )
        attempts.append(result.text)

        try:
            raw_output = parse_json_object(result.text)
        except (json.JSONDecodeError, ValueError) as exc:
            last_errors = [f"Builder output was not valid JSON: {exc}"]
            messages = messages + [
                {"role": "assistant", "content": result.text},
                {"role": "user", "content": build_repair_prompt(result.text, last_errors)},
            ]
            continue

        action = raw_output.get("action")

        if action == "clarify":
            return BuilderOutput(
                action="clarify",
                message=raw_output.get("message"),
                missingFields=raw_output.get("missingFields", []),
            )

        if action not in ("draft", "update"):
            # Seen in practice: the model returns the SkillSpec object
            # directly at the top level instead of wrapping it in the
            # required envelope. Name that mistake explicitly in the repair
            # hint — "unknown action: None" alone wasn't actionable enough
            # and the model repeated the same mistake on repair.
            looks_like_bare_spec = "execution" in raw_output or "schemaVersion" in raw_output
            hint = (
                ' You returned the SkillSpec directly at the top level. You MUST wrap it: '
                '{"action": "draft", "spec": <the SkillSpec you just produced>}.'
                if looks_like_bare_spec
                else ""
            )
            last_errors = [f'Builder output is missing a valid top-level "action" field (got: {action!r}).{hint}']
            messages = messages + [
                {"role": "assistant", "content": result.text},
                {"role": "user", "content": build_repair_prompt(result.text, last_errors)},
            ]
            continue

        spec = raw_output.get("spec")

        try:
            validate_skill_spec(spec)
        except AppError as exc:
            last_errors = (exc.details or {}).get("errors", [str(exc)])
            messages = messages + [
                {"role": "assistant", "content": result.text},
                {"role": "user", "content": build_repair_prompt(result.text, last_errors)},
            ]
            continue

        registry_errors = validate_against_registries(
            spec,
            model_ids={m["modelId"] for m in context["availableModels"]},
            tool_ids={t["toolId"] for t in context["availableTools"]},
            capabilities=context["availableCapabilities"],
            available_skill_ids={s["id"] for s in context["availableSkills"]},
            available_document_ids={d["id"] for d in context["availableKnowledge"]},
        )
        if registry_errors:
            last_errors = registry_errors
            messages = messages + [
                {"role": "assistant", "content": result.text},
                {"role": "user", "content": build_repair_prompt(result.text, last_errors)},
            ]
            continue

        # `spec` (the already-validated raw dict) is returned as-is — never
        # re-serialized through the Pydantic model, which would turn unset
        # optional fields into explicit `null`s and break re-validation.
        return BuilderOutput(
            action=action,  # type: ignore[arg-type]
            message=raw_output.get("message"),
            changeSummary=raw_output.get("changeSummary"),
            missingFields=raw_output.get("missingFields"),
            spec=spec,
        )

    raise AppError(
        "validation_error",
        "Skill Builder could not produce a valid Skill Spec after repair",
        {"errors": last_errors, "attempts": attempts},
    )


async def build_skill(
    builder_input: BuilderInput,
    model_client: ModelClient,
    builder_model_id: str = "model-001",
) -> BuilderOutput:
    if builder_input.currentSpec is not None:
        raise AppError("validation_error", "build (create) does not accept a currentSpec — use refine instead")
    return await _run_pipeline("create", builder_input, model_client, builder_model_id)


async def refine_skill(
    builder_input: BuilderInput,
    model_client: ModelClient,
    builder_model_id: str = "model-001",
) -> BuilderOutput:
    if builder_input.currentSpec is None:
        raise AppError("validation_error", "refine requires currentSpec")
    return await _run_pipeline("refine", builder_input, model_client, builder_model_id)
