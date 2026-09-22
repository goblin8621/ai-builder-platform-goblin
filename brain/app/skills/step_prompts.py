"""Prompt construction for the `llm` Step Executor (08. Skill Runtime 설계).

Mirrors the marker-based approach used in prompts.py for the Builder:
the exact structured input a real LLM receives is embedded as one JSON
blob after a fixed marker, so a deterministic dev/test ModelClient can
parse it without any NL understanding.
"""
from __future__ import annotations

import json
from typing import Any

STEP_INPUT_MARKER = "STEP_EXECUTION_JSON:"


def build_step_system_prompt(objective: str, rules: list[str]) -> str:
    rules_text = "\n".join(f"- {r}" for r in rules) if rules else "(none)"
    return (
        "You are executing one Step of a Skill. Follow the Skill's objective and rules "
        "exactly; do not add unrelated content.\n\n"
        f"Objective: {objective}\n"
        f"Rules:\n{rules_text}\n\n"
        "Respond with ONLY a single JSON object matching the given output schema — "
        "no prose, no markdown code fences."
    )


def build_step_user_prompt(step_input: dict[str, Any], output_schema: dict[str, Any]) -> str:
    payload = {"input": step_input, "outputSchema": output_schema}
    return f"{STEP_INPUT_MARKER}\n{json.dumps(payload, ensure_ascii=False)}"
