"""Deterministic, rule-based ModelClient used for `llm` Step execution
when no real LLM is configured (no ANTHROPIC_API_KEY).

NOT real intelligence — it exists purely so the Execution Engine's data
flow (input resolution -> step dispatch -> output construction -> Output
Schema Validation -> persistence) can be exercised and tested end-to-end
without external API credentials. It fabricates a schema-conformant
placeholder value for each required output property. Swap in
AnthropicModelClient for real Step output — see brain/app/skills/runtime_router.py
for the selection logic (same pattern as the Builder's HeuristicModelClient).
"""
from __future__ import annotations

import json
from typing import Any

from app.common.models.interface import ModelClient, ModelCompletionRequest, ModelCompletionResult
from app.skills.step_prompts import STEP_INPUT_MARKER


def _extract_step_payload(messages: list[dict[str, Any]]) -> dict[str, Any]:
    for message in reversed(messages):
        content = message.get("content", "")
        if STEP_INPUT_MARKER in content:
            _, _, json_part = content.partition(STEP_INPUT_MARKER)
            return json.loads(json_part.strip())
    raise ValueError("No STEP_EXECUTION_JSON marker found in conversation")


def _echo_text(step_input: dict[str, Any]) -> str:
    strings = [v for v in step_input.values() if isinstance(v, str) and v.strip()]
    body = " ".join(strings) if strings else "no input text"
    return f"[heuristic-runtime placeholder] {body}"


def _placeholder_for_property(name: str, prop_schema: dict[str, Any], step_input: dict[str, Any]) -> Any:
    prop_type = prop_schema.get("type")
    if prop_type == "string":
        return _echo_text(step_input)
    if prop_type in ("number", "integer"):
        return 0
    if prop_type == "boolean":
        return False
    if prop_type == "array":
        return []
    if prop_type == "object":
        return {}
    return _echo_text(step_input)


def build_placeholder_output(output_schema: dict[str, Any], step_input: dict[str, Any]) -> dict[str, Any]:
    properties = output_schema.get("properties", {})
    required = output_schema.get("required", list(properties.keys()))
    return {name: _placeholder_for_property(name, properties.get(name, {}), step_input) for name in required}


class HeuristicRuntimeModelClient(ModelClient):
    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResult:
        payload = _extract_step_payload(request.messages)
        output = build_placeholder_output(payload.get("outputSchema", {}), payload.get("input", {}))
        return ModelCompletionResult(text=json.dumps(output, ensure_ascii=False))
