"""Shared helper for parsing a Model Client's raw text as a JSON object.

Used by both the Skill Builder (structured Skill Spec output) and the
Skill Runtime's `llm` Step Executor (structured Step output) — both ask
the model to respond with ONLY a JSON object and need the same
defensive fence-stripping before `json.loads`.
"""
from __future__ import annotations

import json
from typing import Any


def parse_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    return json.loads(cleaned)
