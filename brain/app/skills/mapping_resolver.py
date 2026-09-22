"""Mapping Resolver (08번 Skill Runtime 설계, Phase 5 설계 결정).

The ONLY place `SkillStep.inputMap` and `Execution.outputMap` values are
interpreted. Used by both the Execution Engine (runtime resolution) and
the static Skill Spec validator (structural checks of `$ref` shape/step
references) — kept in its own module specifically so neither caller has
to duplicate the grammar.

Grammar (fixed, no arbitrary expression evaluation — 08번: "임의 표현식
실행은 피하고 제한된 Mapping 규칙을 사용"):

    {"$ref": "input"}                       -> the whole Run Input
    {"$ref": "input.<dot.path>"}            -> a field of the Run Input
    {"$ref": "steps.<stepId>.output"}       -> a previous Step's whole output
    {"$ref": "steps.<stepId>.output.<dot.path>"} -> a field of it
    anything else (including a plain string) -> a Static Value, used as-is

A value is a Mapping Reference ONLY if it is a JSON object with exactly
one key, `$ref`, whose value is a string. This is why a plain string like
`"input.text"` is a Static Value, not a reference — only the explicit
`{"$ref": ...}` object form is (P5 결정: "일반 문자열과 참조 문자열이
구분되지 않는 문제").
"""
from __future__ import annotations

from typing import Any


class MappingError(Exception):
    """Raised for any unresolvable $ref: unknown step id, a step that has
    not produced output yet (not yet executed, skipped, or failed), a
    path that doesn't exist, or a malformed $ref string."""


def is_mapping_ref(value: Any) -> bool:
    return isinstance(value, dict) and set(value.keys()) == {"$ref"} and isinstance(value["$ref"], str)


def _get_by_path(data: Any, path: str, ref_for_error: str) -> Any:
    current = data
    for part in path.split(".") if path else []:
        if not isinstance(current, dict) or part not in current:
            raise MappingError(f'$ref "{ref_for_error}": path "{path}" not found')
        current = current[part]
    return current


def resolve_ref(ref: str, run_input: dict[str, Any], step_outputs: dict[str, dict[str, Any]]) -> Any:
    """Resolves a single `$ref` string against the Run Input and the
    outputs of Steps that have already completed. `step_outputs` must
    contain ONLY Steps that actually produced output — a missing key is
    indistinguishable from "not yet executed / skipped / failed", which is
    intentional (08번: "아직 실행되지 않은 Step 참조 차단")."""
    if ref == "input":
        return run_input
    if ref.startswith("input."):
        return _get_by_path(run_input, ref[len("input.") :], ref)

    if ref.startswith("steps."):
        rest = ref[len("steps.") :]
        step_id, sep, tail = rest.partition(".output")
        if not sep:
            raise MappingError(f'invalid $ref "{ref}": expected "steps.<stepId>.output[.<path>]"')
        if step_id not in step_outputs:
            raise MappingError(
                f'$ref "{ref}" references step "{step_id}", which has not produced output '
                "(unknown step id, not yet executed, skipped, or failed)"
            )
        path = tail[1:] if tail.startswith(".") else tail
        return _get_by_path(step_outputs[step_id], path, ref)

    raise MappingError(f'invalid $ref "{ref}": must start with "input" or "steps."')


def resolve_mapping(
    mapping: dict[str, Any],
    run_input: dict[str, Any],
    step_outputs: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Resolves every entry of an `inputMap` / `outputMap` dict. Raises
    `MappingError` on the first unresolvable reference — never returns a
    partially-resolved mapping."""
    resolved: dict[str, Any] = {}
    for target_key, value in mapping.items():
        resolved[target_key] = resolve_ref(value["$ref"], run_input, step_outputs) if is_mapping_ref(value) else value
    return resolved
