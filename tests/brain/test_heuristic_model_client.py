import json

import pytest

from app.common.models.heuristic_client import HeuristicModelClient
from app.common.models.interface import ModelCompletionRequest
from app.skills.prompts import build_system_prompt, build_user_prompt


def _context(request: str, current_spec=None, available_tools=None):
    return {
        "request": request,
        "currentSpec": current_spec,
        "availableModels": [{"modelId": "model-001", "displayName": "General", "provider": "internal"}],
        "availableCapabilities": {
            "webSearch": False,
            "imageGeneration": False,
            "codeExecution": False,
            "dataAnalysis": False,
            "fileAnalysis": False,
            "knowledgeSearch": False,
            "mcp": False,
        },
        "availableTools": available_tools or [],
        "availableSkills": [],
        "availableKnowledge": [],
        "defaults": {},
    }


def _messages(context: dict, mode: str = "create"):
    return [
        {"role": "system", "content": build_system_prompt(mode)},
        {"role": "user", "content": build_user_prompt(context)},
    ]


@pytest.mark.asyncio
async def test_create_translation_request_yields_prompt_skill():
    client = HeuristicModelClient()
    context = _context("입력받은 한국어 문장을 자연스러운 영어로 번역해줘")
    result = await client.complete(ModelCompletionRequest(model_id="model-001", messages=_messages(context)))

    output = json.loads(result.text)
    assert output["action"] == "draft"
    assert output["spec"]["skillType"] == "prompt"


@pytest.mark.asyncio
async def test_create_knowledge_request_yields_knowledge_skill():
    client = HeuristicModelClient()
    context = _context("업로드된 운영 가이드 문서에서 질문에 대한 답을 찾아줘")
    result = await client.complete(ModelCompletionRequest(model_id="model-001", messages=_messages(context)))

    output = json.loads(result.text)
    assert output["spec"]["skillType"] == "knowledge"
    assert output["spec"]["capabilities"]["knowledgeSearch"] is True


@pytest.mark.asyncio
async def test_create_tool_request_yields_tool_skill_referencing_available_tool():
    client = HeuristicModelClient()
    tools = [{"toolId": "service-status", "displayName": "Service Status", "inputSchema": {}, "outputSchema": {}}]
    context = _context("서비스 상태를 조회하는 API를 호출해줘", available_tools=tools)
    result = await client.complete(ModelCompletionRequest(model_id="model-001", messages=_messages(context)))

    output = json.loads(result.text)
    assert output["spec"]["skillType"] == "tool"
    assert output["spec"]["execution"]["steps"][0]["refId"] == "service-status"


@pytest.mark.asyncio
async def test_refine_preserves_unrelated_fields_and_adds_a_rule():
    client = HeuristicModelClient()
    current_spec = {
        "schemaVersion": "1.0",
        "name": "Existing Skill",
        "description": "desc",
        "skillType": "prompt",
        "inputSchema": {"type": "object"},
        "outputSchema": {"type": "object"},
        "instructions": {"objective": "do the thing", "rules": ["existing rule"]},
        "model": {"mode": "user", "modelId": None, "allowUserOverride": True},
        "capabilities": {
            "webSearch": False,
            "imageGeneration": False,
            "codeExecution": False,
            "dataAnalysis": False,
            "fileAnalysis": False,
            "knowledgeSearch": False,
            "mcp": False,
        },
        "knowledge": {"mode": "none", "documentIds": []},
        "execution": {"steps": [{"id": "s1", "name": "Step", "type": "llm"}]},
        "runtime": {"timeoutSec": 30, "retryCount": 1, "maxToolCalls": 0, "maxNestedSkillDepth": 0},
        "guardrails": ["existing guardrail"],
        "usageExamples": [],
        "metadata": {"category": "x", "tags": ["y"]},
    }
    context = _context("항상 존댓말로 답변해줘", current_spec=current_spec)
    result = await client.complete(ModelCompletionRequest(model_id="model-001", messages=_messages(context, "refine")))

    output = json.loads(result.text)
    assert output["action"] == "update"
    spec = output["spec"]
    assert spec["name"] == "Existing Skill"
    assert spec["guardrails"] == ["existing guardrail"]
    assert spec["metadata"] == {"category": "x", "tags": ["y"]}
    assert "existing rule" in spec["instructions"]["rules"]
    assert "항상 존댓말로 답변해줘" in spec["instructions"]["rules"]
