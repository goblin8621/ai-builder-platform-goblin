"""Deterministic, rule-based ModelClient used when no real LLM is configured.

NOT a natural-language understanding system. It exists purely so the
Builder pipeline (validation, repair loop, Registry checks, refine
field-preservation) can be exercised and tested end-to-end without
external API credentials. Swap in AnthropicModelClient (or another real
ModelClient) for actual NL understanding — see brain/app/main.py for the
selection logic (mirrors Phase 1's DevAuthContextProvider pattern: a
clearly-labelled dev/demo implementation behind the same interface as the
real one).
"""
from __future__ import annotations

import json
import re
from typing import Any

from app.common.models.interface import ModelClient, ModelCompletionRequest, ModelCompletionResult
from app.skills.prompts import BUILDER_INPUT_MARKER

_EMPTY_CAPABILITIES = {
    "webSearch": False,
    "imageGeneration": False,
    "codeExecution": False,
    "dataAnalysis": False,
    "fileAnalysis": False,
    "knowledgeSearch": False,
    "mcp": False,
}

_KEYWORD_ROUTES: list[tuple[list[str], str]] = [
    (["번역", "translate"], "prompt"),
    (["문서", "검색", "지식", "knowledge"], "knowledge"),
    (["api", "상태", "조회", "status"], "tool"),
]


def _extract_builder_input(messages: list[dict[str, Any]]) -> dict[str, Any]:
    for message in reversed(messages):
        content = message.get("content", "")
        if BUILDER_INPUT_MARKER in content:
            _, _, json_part = content.partition(BUILDER_INPUT_MARKER)
            return json.loads(json_part.strip())
    raise ValueError("No BUILDER_INPUT_JSON marker found in conversation")


def _slugify_name(text: str, max_words: int = 6) -> str:
    words = re.findall(r"[\w가-힣]+", text)
    return " ".join(words[:max_words]).strip() or "Untitled Skill"


def _draft_prompt_skill(request: str) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "name": _slugify_name(request),
        "description": request.strip()[:200] or "Generated prompt Skill",
        "skillType": "prompt",
        "inputSchema": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}},
        "outputSchema": {"type": "object", "required": ["result"], "properties": {"result": {"type": "string"}}},
        "instructions": {"objective": request.strip() or "Follow the user's instruction.", "rules": []},
        "model": {"mode": "user", "modelId": None, "allowUserOverride": True},
        "capabilities": dict(_EMPTY_CAPABILITIES),
        "knowledge": {"mode": "none", "documentIds": []},
        "execution": {"steps": [{"id": "respond", "name": "Respond", "type": "llm"}]},
        "runtime": {"timeoutSec": 30, "retryCount": 1, "maxToolCalls": 0, "maxNestedSkillDepth": 0},
        "guardrails": [],
        "usageExamples": [],
        "metadata": {"category": "general", "tags": []},
    }


def _draft_knowledge_skill(request: str) -> dict[str, Any]:
    spec = _draft_prompt_skill(request)
    spec["skillType"] = "knowledge"
    spec["capabilities"] = dict(_EMPTY_CAPABILITIES, knowledgeSearch=True)
    spec["knowledge"] = {"mode": "workspace", "documentIds": []}
    spec["inputSchema"] = {"type": "object", "required": ["question"], "properties": {"question": {"type": "string"}}}
    spec["outputSchema"] = {"type": "object", "required": ["answer"], "properties": {"answer": {"type": "string"}}}
    spec["execution"] = {
        "steps": [
            {"id": "search", "name": "Search knowledge", "type": "knowledge"},
            {"id": "answer", "name": "Answer from sources", "type": "llm"},
        ]
    }
    return spec


def _draft_tool_skill(request: str, tool_id: str) -> dict[str, Any]:
    spec = _draft_prompt_skill(request)
    spec["skillType"] = "tool"
    spec["execution"] = {"steps": [{"id": "call-tool", "name": "Call tool", "type": "tool", "refId": tool_id}]}
    return spec


class HeuristicModelClient(ModelClient):
    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResult:
        builder_input = _extract_builder_input(request.messages)
        text = builder_input.get("request", "")
        current_spec = builder_input.get("currentSpec")
        available_tools = builder_input.get("availableTools", [])

        if current_spec is not None:
            output = self._refine(current_spec, text)
        else:
            output = self._create(text, available_tools)

        return ModelCompletionResult(text=json.dumps(output, ensure_ascii=False))

    def _create(self, text: str, available_tools: list[dict[str, Any]]) -> dict[str, Any]:
        lowered = text.lower()
        for keywords, kind in _KEYWORD_ROUTES:
            if not any(k in text or k in lowered for k in keywords):
                continue
            if kind == "knowledge":
                return {
                    "action": "draft",
                    "message": "Generated a knowledge Skill.",
                    "missingFields": [],
                    "spec": _draft_knowledge_skill(text),
                }
            if kind == "tool":
                tool_id = next((t.get("toolId") for t in available_tools if t.get("toolId") == "service-status"), None)
                tool_id = tool_id or (available_tools[0]["toolId"] if available_tools else None)
                if tool_id:
                    return {
                        "action": "draft",
                        "message": "Generated a tool Skill.",
                        "missingFields": [],
                        "spec": _draft_tool_skill(text, tool_id),
                    }
        return {"action": "draft", "message": "Generated a prompt Skill.", "missingFields": [], "spec": _draft_prompt_skill(text)}

    def _refine(self, current_spec: dict[str, Any], text: str) -> dict[str, Any]:
        spec = json.loads(json.dumps(current_spec))  # deep copy, never mutate caller's dict
        change_summary: list[str] = []

        rule = text.strip()
        if rule and rule not in spec.get("instructions", {}).get("rules", []):
            spec.setdefault("instructions", {}).setdefault("rules", []).append(rule)
            change_summary.append(f'Added rule from request: "{rule}"')

        if not change_summary:
            change_summary.append("No unambiguous change detected; Skill left unchanged.")

        return {"action": "update", "changeSummary": change_summary, "spec": spec}
