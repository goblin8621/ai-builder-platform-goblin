"""SkillSpec validation (03. Skill Spec 계약 기준).

Validates a raw dict against contracts/skill-spec.schema.json (the same
file bff/src/skills/skill-spec-validator.ts uses), then runs the same
semantic checks as the TS side, then returns a typed SkillSpecV1.

Registry-dependent checks (model/tool/skill/document existence, server
Capability support, Nested Skill cycle/depth) are intentionally NOT done
here — the Registry does not exist until Phase 3, and Builder-time
Registry validation is Phase 4 (04번 문서). This module only enforces
what the Skill Spec can validate about itself.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator
from jsonschema.exceptions import SchemaError

from app.common.errors import AppError
from app.skills.mapping_resolver import is_mapping_ref
from app.skills.schemas import SkillSpecV1

_SCHEMA_PATH = Path(__file__).resolve().parents[3] / "contracts" / "skill-spec.schema.json"


def _load_schema() -> dict[str, Any]:
    return json.loads(_SCHEMA_PATH.read_text())


_SCHEMA = _load_schema()
_VALIDATOR = Draft7Validator(_SCHEMA)


def _is_valid_json_schema(candidate: Any) -> bool:
    if not isinstance(candidate, dict):
        return False
    try:
        # Proves the embedded sub-schema is well-formed
        # (03번: "Input/Output Schema가 유효한 JSON Schema인지 확인").
        Draft7Validator.check_schema(candidate)
        return True
    except SchemaError:
        return False


def _validate_ref_string(ref: str, referenceable_step_ids: set[str], mapping_path: str) -> list[str]:
    """Static structural check of one `$ref` string (P5 결정사항 #2):
    does NOT execute anything, only checks the referenced step id is one
    that could ever have output at this point in the Skill. The actual
    resolution (and its own defensive checks) lives in
    app.skills.mapping_resolver, used at Run time."""
    if ref == "input" or ref.startswith("input."):
        return []
    if ref.startswith("steps."):
        rest = ref[len("steps.") :]
        step_id, sep, _tail = rest.partition(".output")
        if not sep:
            return [f'{mapping_path}: invalid $ref "{ref}" (expected "steps.<stepId>.output[.<path>]")']
        if step_id not in referenceable_step_ids:
            return [
                f'{mapping_path}: $ref "{ref}" references step "{step_id}", which does not exist or '
                "cannot have executed yet at this point (must appear earlier in execution.steps)"
            ]
        return []
    return [f'{mapping_path}: invalid $ref "{ref}" (must start with "input" or "steps.")']


def _validate_mapping_table(mapping: dict[str, Any], referenceable_step_ids: set[str], mapping_path: str) -> list[str]:
    errors: list[str] = []
    for key, value in mapping.items():
        if is_mapping_ref(value):
            errors.extend(_validate_ref_string(value["$ref"], referenceable_step_ids, f"{mapping_path}/{key}"))
    return errors


def _run_semantic_checks(spec: dict[str, Any]) -> list[str]:
    """Mirrors bff/src/skills/skill-spec-validator.ts::runSemanticChecks —
    keep both in sync; tests/contract/skill-spec fixtures assert they agree."""
    errors: list[str] = []

    if not _is_valid_json_schema(spec.get("inputSchema")):
        errors.append("/inputSchema: inputSchema must be a valid JSON Schema")
    if not _is_valid_json_schema(spec.get("outputSchema")):
        errors.append("/outputSchema: outputSchema must be a valid JSON Schema")

    steps = spec.get("execution", {}).get("steps", [])
    seen_ids: set[str] = set()
    for step in steps:
        step_id = step.get("id")
        if step_id in seen_ids:
            errors.append(f"/execution/steps: duplicate step id: {step_id}")
        seen_ids.add(step_id)

    step_ids = {s.get("id") for s in steps}
    for step in steps:
        on_error = step.get("onError")
        if on_error and on_error.get("action") == "fallback":
            target = on_error.get("fallbackStepId")
            if not target or target not in step_ids:
                errors.append(
                    f"/execution/steps/{step.get('id')}/onError/fallbackStepId: "
                    f'fallbackStepId "{target or ""}" does not reference an existing step'
                )

    # $ref structural checks (P5 결정사항 #2): a Step's inputMap may only
    # reference a step id that appears EARLIER in execution.steps (it
    # cannot possibly have output yet otherwise); execution.outputMap is
    # resolved after every Step runs, so it may reference ANY step id.
    step_id_order = [s.get("id") for s in steps]
    for index, step in enumerate(steps):
        input_map = step.get("inputMap")
        if input_map:
            referenceable = set(step_id_order[:index])
            errors.extend(
                _validate_mapping_table(input_map, referenceable, f"/execution/steps/{step.get('id')}/inputMap")
            )

    output_map = spec.get("execution", {}).get("outputMap")
    if output_map:
        errors.extend(_validate_mapping_table(output_map, step_ids, "/execution/outputMap"))

    return errors


def validate_skill_spec(spec: dict[str, Any]) -> SkillSpecV1:
    """Validates `spec` and returns a typed SkillSpecV1.

    Raises AppError(code="validation_error") with every violation collected
    in `details["errors"]` — never partial/silent acceptance
    (03번: "수정 시 전체 Spec을 재검증").
    """
    structural_errors = sorted(
        f"{'/'.join(str(p) for p in e.path) or '(root)'}: {e.message}"
        for e in _VALIDATOR.iter_errors(spec)
    )
    if structural_errors:
        raise AppError(
            "validation_error",
            "Skill Spec failed schema validation",
            {"errors": structural_errors},
        )

    semantic_errors = _run_semantic_checks(spec)
    if semantic_errors:
        raise AppError(
            "validation_error",
            "Skill Spec failed semantic validation",
            {"errors": semantic_errors},
        )

    return SkillSpecV1.model_validate(spec)
