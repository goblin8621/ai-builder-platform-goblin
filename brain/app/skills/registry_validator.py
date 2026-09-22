"""Builder-time Registry Validation (03번 필수 검증, Phase 4).

Checks a Builder-generated Skill Spec against the Registry data actually
available to the Builder call. This mirrors bff/src/skills/skill-registry-validator.ts
but scoped to what Brain can check without a database:
- modelId / tool refId / capabilities — checked against Brain's own
  Model/Tool/Capability registries (in-process, no HTTP needed).
- skill refId / knowledge documentIds — checked only against the
  `availableSkills` / `availableKnowledge` lists BFF supplied (Brain has
  no direct DB access).

Full transitive Skill-cycle detection remains authoritative at BFF
save-time (Phase 3) — this function only checks existence, so a Builder
draft that would create a cycle is still caught (and rejected) when the
BFF actually persists it, consistent with "Builder는 Spec 생성, Runtime/
저장 계층이 최종 검증" role separation.
"""
from __future__ import annotations

from typing import Any


def validate_against_registries(
    spec: dict[str, Any],
    *,
    model_ids: set[str],
    tool_ids: set[str],
    capabilities: dict[str, bool],
    available_skill_ids: set[str],
    available_document_ids: set[str],
) -> list[str]:
    errors: list[str] = []

    model = spec.get("model", {})
    model_id = model.get("modelId")
    if model.get("mode") != "user" and model_id and model_id not in model_ids:
        errors.append(f'/model/modelId: modelId "{model_id}" is not a known Model Registry entry')

    for flag, enabled in spec.get("capabilities", {}).items():
        if enabled and not capabilities.get(flag, False):
            errors.append(f'/capabilities/{flag}: capability "{flag}" is not supported by this server')

    for step in spec.get("execution", {}).get("steps", []):
        step_id = step.get("id")
        if step.get("type") == "tool":
            ref_id = step.get("refId")
            if not ref_id or ref_id not in tool_ids:
                errors.append(
                    f'/execution/steps/{step_id}/refId: refId "{ref_id or ""}" is not a known Tool Registry entry'
                )
        if step.get("type") == "skill":
            ref_id = step.get("refId")
            if not ref_id or ref_id not in available_skill_ids:
                errors.append(
                    f'/execution/steps/{step_id}/refId: refId "{ref_id or ""}" is not a known Skill available to the Builder'
                )

    knowledge = spec.get("knowledge", {})
    if knowledge.get("mode") == "selected":
        for doc_id in knowledge.get("documentIds", []):
            if doc_id not in available_document_ids:
                errors.append(f'/knowledge/documentIds: documentId "{doc_id}" is not available to the Builder')

    return errors
