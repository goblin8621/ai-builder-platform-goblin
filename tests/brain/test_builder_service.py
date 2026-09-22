import json

import pytest

from app.common.errors import AppError
from app.common.models.heuristic_client import HeuristicModelClient
from app.common.models.interface import ModelClient, ModelCompletionRequest, ModelCompletionResult
from app.skills.builder_service import BuilderInput, build_skill, refine_skill


class ScriptedModelClient(ModelClient):
    """Test double that replays a fixed sequence of raw text responses,
    so the Builder's repair loop can be exercised deterministically
    without depending on the heuristic client's always-valid behavior."""

    def __init__(self, responses: list[str]):
        self._responses = list(responses)
        self.call_count = 0

    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResult:
        text = self._responses[min(self.call_count, len(self._responses) - 1)]
        self.call_count += 1
        return ModelCompletionResult(text=text)


VALID_PROMPT_SPEC = {
    "schemaVersion": "1.0",
    "name": "Translator",
    "description": "translate",
    "skillType": "prompt",
    "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}},
    "outputSchema": {"type": "object", "properties": {"translatedText": {"type": "string"}}},
    "instructions": {"objective": "translate", "rules": []},
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
    "execution": {"steps": [{"id": "translate", "name": "Translate", "type": "llm"}]},
    "runtime": {"timeoutSec": 30, "retryCount": 1, "maxToolCalls": 0, "maxNestedSkillDepth": 0},
    "guardrails": [],
    "usageExamples": [],
    "metadata": {"category": "translation", "tags": []},
}


def draft_response(spec: dict) -> str:
    return json.dumps({"action": "draft", "message": "ok", "missingFields": [], "spec": spec})


@pytest.mark.asyncio
async def test_build_skill_succeeds_on_first_try_with_heuristic_client():
    builder_input = BuilderInput(request="입력받은 한국어 문장을 자연스러운 영어로 번역해줘")
    output = await build_skill(builder_input, HeuristicModelClient())

    assert output.action == "draft"
    assert output.spec["skillType"] == "prompt"


@pytest.mark.asyncio
async def test_build_skill_repairs_malformed_json_on_second_attempt():
    client = ScriptedModelClient(["not json at all", draft_response(VALID_PROMPT_SPEC)])
    builder_input = BuilderInput(request="번역 Skill 만들어줘")

    output = await build_skill(builder_input, client)

    assert client.call_count == 2
    assert output.action == "draft"
    assert output.spec["name"] == "Translator"


@pytest.mark.asyncio
async def test_build_skill_gives_up_after_one_repair_attempt():
    client = ScriptedModelClient(["not json", "still not json"])
    builder_input = BuilderInput(request="번역 Skill 만들어줘")

    with pytest.raises(AppError) as exc_info:
        await build_skill(builder_input, client)

    assert exc_info.value.code == "validation_error"
    assert client.call_count == 2
    assert len(exc_info.value.details["attempts"]) == 2


@pytest.mark.asyncio
async def test_build_skill_rejects_unknown_model_id_even_after_repair():
    bad_spec = {**VALID_PROMPT_SPEC, "model": {"mode": "fixed", "modelId": "model-999", "allowUserOverride": False}}
    client = ScriptedModelClient([draft_response(bad_spec), draft_response(bad_spec)])
    builder_input = BuilderInput(request="번역 Skill 만들어줘")

    with pytest.raises(AppError) as exc_info:
        await build_skill(builder_input, client)

    assert exc_info.value.code == "validation_error"
    assert any("modelId" in e for e in exc_info.value.details["errors"])


@pytest.mark.asyncio
async def test_build_skill_returns_clarify_without_requiring_a_spec():
    client = ScriptedModelClient(
        [json.dumps({"action": "clarify", "missingFields": ["targetLanguage"], "message": "어떤 언어로 번역할까요?"})]
    )
    builder_input = BuilderInput(request="번역해줘")

    output = await build_skill(builder_input, client)

    assert output.action == "clarify"
    assert output.missingFields == ["targetLanguage"]
    assert output.spec is None


@pytest.mark.asyncio
async def test_build_skill_rejects_a_currentSpec_being_supplied():
    builder_input = BuilderInput(request="x", currentSpec=VALID_PROMPT_SPEC)
    with pytest.raises(AppError) as exc_info:
        await build_skill(builder_input, HeuristicModelClient())
    assert exc_info.value.code == "validation_error"


@pytest.mark.asyncio
async def test_refine_skill_requires_a_currentSpec():
    builder_input = BuilderInput(request="x")
    with pytest.raises(AppError) as exc_info:
        await refine_skill(builder_input, HeuristicModelClient())
    assert exc_info.value.code == "validation_error"


@pytest.mark.asyncio
async def test_refine_skill_succeeds_with_heuristic_client():
    builder_input = BuilderInput(request="항상 존댓말로 답변해줘", currentSpec=VALID_PROMPT_SPEC)
    output = await refine_skill(builder_input, HeuristicModelClient())

    assert output.action == "update"
    assert "항상 존댓말로 답변해줘" in output.spec["instructions"]["rules"]
    assert output.spec["name"] == VALID_PROMPT_SPEC["name"]
