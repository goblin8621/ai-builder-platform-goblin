import pytest

from app.common.models.heuristic_runtime_client import HeuristicRuntimeModelClient
from app.common.models.interface import ModelClient, ModelCompletionRequest, ModelCompletionResult
from app.skills.execution_engine import execute_skill

PROMPT_SPEC = {
    "schemaVersion": "1.0",
    "name": "Translator",
    "description": "translate",
    "skillType": "prompt",
    "inputSchema": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}},
    "outputSchema": {
        "type": "object",
        "required": ["translatedText"],
        "properties": {"translatedText": {"type": "string"}},
    },
    "instructions": {"objective": "translate to English", "rules": ["no explanations"]},
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


class ScriptedModelClient(ModelClient):
    def __init__(self, responses: list[str]):
        self._responses = list(responses)
        self.calls: list[ModelCompletionRequest] = []

    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResult:
        self.calls.append(request)
        return ModelCompletionResult(text=self._responses[min(len(self.calls) - 1, len(self._responses) - 1)])


@pytest.mark.asyncio
async def test_single_llm_step_completes_with_heuristic_client():
    result = await execute_skill(PROMPT_SPEC, {"text": "안녕하세요"}, HeuristicRuntimeModelClient())

    assert result.status == "completed"
    assert "translatedText" in result.output
    assert result.steps[0].status == "completed"
    assert result.steps[0].stepId == "translate"


@pytest.mark.asyncio
async def test_llm_step_uses_run_input_directly_when_no_inputMap():
    client = ScriptedModelClient(['{"translatedText": "Hello"}'])
    result = await execute_skill(PROMPT_SPEC, {"text": "안녕하세요"}, client)

    assert result.status == "completed"
    assert result.output == {"translatedText": "Hello"}
    # The step received the raw run input as-is (no inputMap declared).
    assert "안녕하세요" in client.calls[0].messages[1]["content"]


@pytest.mark.asyncio
async def test_output_failing_schema_marks_run_failed():
    client = ScriptedModelClient(['{"wrongField": "oops"}'])
    result = await execute_skill(PROMPT_SPEC, {"text": "hi"}, client)

    assert result.status == "failed"
    assert "outputSchema" in result.error
    assert result.steps[0].status == "completed"  # the step itself succeeded; output validation failed after
    # P8 사용자 결정 #3: Debug must be able to tell "the Step worked but the
    # combined Output doesn't match outputSchema" apart from a real Runtime
    # failure — the actual (invalid) output and structured errors survive
    # the failure instead of being discarded.
    assert result.output == {"wrongField": "oops"}
    assert len(result.outputValidationErrors) == 1
    assert result.outputValidationErrors[0].path == "(root)"
    assert result.outputValidationErrors[0].message == "'translatedText' is a required property"


@pytest.mark.asyncio
async def test_malformed_llm_output_fails_the_step_and_run():
    client = ScriptedModelClient(["not json"])
    result = await execute_skill(PROMPT_SPEC, {"text": "hi"}, client)

    assert result.status == "failed"
    assert result.steps[0].status == "failed"
    assert "Step 'translate' failed" in result.steps[0].error


@pytest.mark.asyncio
async def test_unsupported_step_type_fails_clearly():
    spec = {**PROMPT_SPEC, "execution": {"steps": [{"id": "branch", "name": "Branch", "type": "condition"}]}}
    result = await execute_skill(spec, {"text": "hi"}, HeuristicRuntimeModelClient())

    assert result.status == "failed"
    assert "not supported" in result.steps[0].error


@pytest.mark.asyncio
async def test_multi_step_chain_resolves_dollar_ref_between_steps():
    spec = {
        **PROMPT_SPEC,
        "outputSchema": {"type": "object", "required": ["final"], "properties": {"final": {"type": "string"}}},
        "execution": {
            "steps": [
                {"id": "step1", "name": "First", "type": "transform"},
                {
                    "id": "step2",
                    "name": "Second",
                    "type": "transform",
                    "inputMap": {"final": {"$ref": "steps.step1.output.text"}},
                },
            ]
        },
    }
    result = await execute_skill(spec, {"text": "carried-value"}, HeuristicRuntimeModelClient())

    assert result.status == "completed"
    # No outputMap declared -> defaults to the last completed Step's output.
    assert result.output == {"final": "carried-value"}
    assert result.steps[0].output == {"text": "carried-value"}


@pytest.mark.asyncio
async def test_plain_string_in_inputMap_is_a_static_value_even_if_it_looks_like_a_ref():
    spec = {
        **PROMPT_SPEC,
        "outputSchema": {"type": "object", "required": ["mode"], "properties": {"mode": {"type": "string"}}},
        "execution": {
            "steps": [
                {
                    "id": "step1",
                    "name": "First",
                    "type": "transform",
                    # A bare string is NEVER a reference, even "input.text" or
                    # "steps.x.output.y" — only the {"$ref": ...} object form is.
                    "inputMap": {"mode": "input.text"},
                }
            ]
        },
    }
    result = await execute_skill(spec, {"text": "irrelevant"}, HeuristicRuntimeModelClient())

    assert result.status == "completed"
    assert result.output == {"mode": "input.text"}


@pytest.mark.asyncio
async def test_inputMap_ref_to_unexecuted_step_fails_the_run_with_a_clear_mapping_error():
    spec = {
        **PROMPT_SPEC,
        "execution": {
            "steps": [
                {
                    "id": "step1",
                    "name": "First",
                    "type": "transform",
                    "inputMap": {"translatedText": {"$ref": "steps.does-not-exist.output.x"}},
                }
            ]
        },
    }
    result = await execute_skill(spec, {"text": "hi"}, HeuristicRuntimeModelClient())

    assert result.status == "failed"
    assert result.steps[0].status == "failed"
    assert "does-not-exist" in result.steps[0].error


@pytest.mark.asyncio
async def test_outputMap_builds_the_final_output_instead_of_the_last_step():
    spec = {
        **PROMPT_SPEC,
        "outputSchema": {
            "type": "object",
            "required": ["translatedText"],
            "properties": {"translatedText": {"type": "string"}},
        },
        "execution": {
            "steps": [
                {
                    "id": "translate",
                    "name": "Translate",
                    "type": "transform",
                    "inputMap": {"text": {"$ref": "input.text"}},
                },
                {"id": "logging", "name": "Irrelevant trailing step", "type": "transform"},
            ],
            "outputMap": {"translatedText": {"$ref": "steps.translate.output.text"}},
        },
    }
    result = await execute_skill(spec, {"text": "hello"}, HeuristicRuntimeModelClient())

    assert result.status == "completed"
    # Without outputMap this would be the trailing "logging" step's output —
    # outputMap picks the real result regardless of step order (P5 결정사항).
    assert result.output == {"translatedText": "hello"}


@pytest.mark.asyncio
async def test_outputMap_can_reference_run_input_directly():
    spec = {
        **PROMPT_SPEC,
        "outputSchema": {"type": "object", "required": ["echo"], "properties": {"echo": {"type": "string"}}},
        "execution": {
            "steps": [{"id": "noop", "name": "No-op", "type": "transform"}],
            "outputMap": {"echo": {"$ref": "input.text"}},
        },
    }
    result = await execute_skill(spec, {"text": "straight-through"}, HeuristicRuntimeModelClient())

    assert result.status == "completed"
    assert result.output == {"echo": "straight-through"}


@pytest.mark.asyncio
async def test_outputMap_ref_to_unknown_step_fails_the_run():
    spec = {
        **PROMPT_SPEC,
        "execution": {
            "steps": [{"id": "step1", "name": "First", "type": "transform"}],
            "outputMap": {"translatedText": {"$ref": "steps.nope.output.x"}},
        },
    }
    result = await execute_skill(spec, {"text": "hi"}, HeuristicRuntimeModelClient())

    assert result.status == "failed"
    assert "outputMap" in result.error
    assert "nope" in result.error
