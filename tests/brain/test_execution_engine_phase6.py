import pytest

from app.common.models.heuristic_runtime_client import HeuristicRuntimeModelClient
from app.common.tools.interface import ToolCallRequest, ToolCallResult, ToolExecutor
from app.skills.execution_engine import ChildSkillRef, execute_skill

BASE_SPEC = {
    "schemaVersion": "1.0",
    "name": "Phase6 Test Skill",
    "description": "test",
    "skillType": "workflow",
    "inputSchema": {"type": "object", "properties": {}},
    "outputSchema": {"type": "object", "properties": {}},
    "instructions": {"objective": "test", "rules": []},
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
    "execution": {"steps": []},
    "runtime": {"timeoutSec": 30, "retryCount": 1, "maxToolCalls": 5, "maxNestedSkillDepth": 2},
    "guardrails": [],
    "usageExamples": [],
    "metadata": {"category": "test", "tags": []},
}


def spec_with(**overrides):
    return {**BASE_SPEC, **overrides}


class FlakyTransformStub:
    """Not a real Step type — used to monkeypatch _execute_transform_step
    indirectly via a 'tool' step whose ToolExecutor fails N times then
    succeeds, since transform steps have no failure mode of their own."""


class CountingToolExecutor(ToolExecutor):
    def __init__(self, fail_times: int = 0):
        self.fail_times = fail_times
        self.calls = 0

    async def call(self, request: ToolCallRequest) -> ToolCallResult:
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError(f"simulated failure #{self.calls}")
        return ToolCallResult(output={"ok": True, "callNumber": self.calls})


# ---------- Retry ----------


@pytest.mark.asyncio
async def test_retry_succeeds_within_retryCount():
    executor = CountingToolExecutor(fail_times=2)
    spec = spec_with(
        execution={
            "steps": [
                {
                    "id": "call",
                    "name": "Call",
                    "type": "tool",
                    "refId": "x",
                    "onError": {"action": "retry", "retryCount": 3},
                }
            ]
        }
    )
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), tool_executor=executor)

    assert result.status == "completed"
    assert executor.calls == 3
    attempts = [s.attempt for s in result.steps if s.stepId == "call"]
    assert attempts == [1, 2, 3]
    assert [s.status for s in result.steps] == ["failed", "failed", "completed"]


@pytest.mark.asyncio
async def test_retry_exhausted_fails_the_run():
    executor = CountingToolExecutor(fail_times=10)
    spec = spec_with(
        execution={
            "steps": [
                {"id": "call", "name": "Call", "type": "tool", "refId": "x", "onError": {"action": "retry", "retryCount": 2}}
            ]
        }
    )
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), tool_executor=executor)

    assert result.status == "failed"
    assert executor.calls == 3  # 1 initial + 2 retries
    assert all(s.status == "failed" for s in result.steps)


# ---------- Fallback ----------


@pytest.mark.asyncio
async def test_fallback_jumps_to_target_step_on_failure():
    executor = CountingToolExecutor(fail_times=999)
    spec = spec_with(
        outputSchema={"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}},
        execution={
            "steps": [
                {
                    "id": "primary",
                    "name": "Primary",
                    "type": "tool",
                    "refId": "x",
                    "onError": {"action": "fallback", "fallbackStepId": "backup"},
                },
                {"id": "backup", "name": "Backup", "type": "transform", "inputMap": {"ok": True}},
            ]
        },
    )
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), tool_executor=executor)

    assert result.status == "completed"
    assert result.output == {"ok": True}
    step_ids_executed = [s.stepId for s in result.steps]
    assert step_ids_executed == ["primary", "backup"]


@pytest.mark.asyncio
async def test_fallback_cycle_back_to_the_starting_step_is_detected():
    # a -> fails -> fallback b -> fails -> fallback c -> fails -> fallback a
    # ("a" was never a fallback *target* before, only the original start —
    # a naive "have we targeted this before" check would miss this loop.)
    executor = CountingToolExecutor(fail_times=999)
    spec = spec_with(
        execution={
            "steps": [
                {"id": "a", "name": "A", "type": "tool", "refId": "x", "onError": {"action": "fallback", "fallbackStepId": "b"}},
                {"id": "b", "name": "B", "type": "tool", "refId": "x", "onError": {"action": "fallback", "fallbackStepId": "c"}},
                {"id": "c", "name": "C", "type": "tool", "refId": "x", "onError": {"action": "fallback", "fallbackStepId": "a"}},
            ]
        }
    )
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), tool_executor=executor)

    assert result.status == "failed"
    assert "infinite Fallback loop" in result.error


@pytest.mark.asyncio
async def test_fallback_cycle_is_detected_and_reported_instead_of_hanging():
    executor = CountingToolExecutor(fail_times=999)
    spec = spec_with(
        execution={
            "steps": [
                {"id": "a", "name": "A", "type": "tool", "refId": "x", "onError": {"action": "fallback", "fallbackStepId": "b"}},
                {"id": "b", "name": "B", "type": "tool", "refId": "x", "onError": {"action": "fallback", "fallbackStepId": "a"}},
            ]
        }
    )
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), tool_executor=executor)

    assert result.status == "failed"
    assert "infinite Fallback loop" in result.error


# ---------- Skip ----------


@pytest.mark.asyncio
async def test_skip_marks_the_step_skipped_and_continues():
    executor = CountingToolExecutor(fail_times=999)
    spec = spec_with(
        outputSchema={"type": "object", "required": ["done"], "properties": {"done": {"type": "boolean"}}},
        execution={
            "steps": [
                {"id": "optional", "name": "Optional", "type": "tool", "refId": "x", "onError": {"action": "skip"}},
                {"id": "final", "name": "Final", "type": "transform", "inputMap": {"done": True}},
            ]
        },
    )
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), tool_executor=executor)

    assert result.status == "completed"
    assert result.output == {"done": True}
    skipped = [s for s in result.steps if s.stepId == "optional"]
    assert skipped[-1].status == "skipped"


@pytest.mark.asyncio
async def test_referencing_a_skipped_steps_output_fails_clearly():
    executor = CountingToolExecutor(fail_times=999)
    spec = spec_with(
        execution={
            "steps": [
                {"id": "optional", "name": "Optional", "type": "tool", "refId": "x", "onError": {"action": "skip"}},
                {
                    "id": "final",
                    "name": "Final",
                    "type": "transform",
                    "inputMap": {"x": {"$ref": "steps.optional.output.x"}},
                },
            ]
        }
    )
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), tool_executor=executor)

    assert result.status == "failed"
    assert "optional" in result.error


# ---------- Tool ----------


@pytest.mark.asyncio
async def test_tool_step_uses_the_configured_executor():
    executor = CountingToolExecutor(fail_times=0)
    spec = spec_with(execution={"steps": [{"id": "call", "name": "Call", "type": "tool", "refId": "any"}]})
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), tool_executor=executor)

    assert result.status == "completed"
    assert result.output == {"ok": True, "callNumber": 1}


@pytest.mark.asyncio
async def test_maxToolCalls_is_enforced_across_the_run():
    executor = CountingToolExecutor(fail_times=0)
    spec = spec_with(
        runtime={"timeoutSec": 30, "retryCount": 1, "maxToolCalls": 1, "maxNestedSkillDepth": 0},
        execution={
            "steps": [
                {"id": "call1", "name": "Call1", "type": "tool", "refId": "x"},
                {"id": "call2", "name": "Call2", "type": "tool", "refId": "x"},
            ]
        },
    )
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), tool_executor=executor)

    assert result.status == "failed"
    assert "maxToolCalls" in result.error


@pytest.mark.asyncio
async def test_tool_step_without_executor_configured_fails_clearly():
    spec = spec_with(execution={"steps": [{"id": "call", "name": "Call", "type": "tool", "refId": "x"}]})
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), tool_executor=None)

    assert result.status == "failed"
    assert "ToolExecutor" in result.steps[0].error


# ---------- Knowledge ----------


@pytest.mark.asyncio
async def test_knowledge_step_returns_ranked_results():
    corpus = [
        {"documentId": "doc-1", "chunkIndex": 0, "content": "결제 장애 대응 절차"},
        {"documentId": "doc-2", "chunkIndex": 0, "content": "휴가 신청 절차"},
    ]
    spec = spec_with(
        execution={
            "steps": [
                {"id": "search", "name": "Search", "type": "knowledge", "inputMap": {"query": "결제 장애"}}
            ]
        }
    )
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), knowledge_corpus=corpus)

    assert result.status == "completed"
    assert result.output["results"][0]["documentId"] == "doc-1"


@pytest.mark.asyncio
async def test_knowledge_step_with_empty_corpus_succeeds_with_no_results():
    spec = spec_with(execution={"steps": [{"id": "search", "name": "Search", "type": "knowledge", "inputMap": {"query": "x"}}]})
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), knowledge_corpus=[])

    assert result.status == "completed"
    assert result.output == {"results": []}


@pytest.mark.asyncio
async def test_knowledge_step_without_query_fails_clearly():
    spec = spec_with(execution={"steps": [{"id": "search", "name": "Search", "type": "knowledge"}]})
    result = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), knowledge_corpus=[])

    assert result.status == "failed"
    assert "query" in result.steps[0].error


# ---------- Nested Skill ----------


CHILD_SPEC = spec_with(
    name="Child",
    outputSchema={"type": "object", "required": ["childDone"], "properties": {"childDone": {"type": "boolean"}}},
    execution={"steps": [{"id": "child-step", "name": "Child Step", "type": "transform", "inputMap": {"childDone": True}}]},
)


@pytest.mark.asyncio
async def test_skill_step_executes_the_provided_child_spec():
    parent_spec = spec_with(
        outputSchema={"type": "object", "required": ["childDone"], "properties": {"childDone": {"type": "boolean"}}},
        execution={"steps": [{"id": "call-child", "name": "Call child", "type": "skill", "refId": "child-1"}]},
    )
    child_skills = {"child-1": ChildSkillRef(skillId="child-1", skillVersionId="v-1", spec=CHILD_SPEC)}

    result = await execute_skill(parent_spec, {}, HeuristicRuntimeModelClient(), child_skills=child_skills)

    assert result.status == "completed"
    assert result.output == {"childDone": True}
    step = result.steps[0]
    assert step.childRun is not None
    assert step.childRun["skillId"] == "child-1"
    assert step.childRun["status"] == "completed"


@pytest.mark.asyncio
async def test_skill_step_with_unresolved_child_fails_clearly():
    parent_spec = spec_with(
        execution={"steps": [{"id": "call-child", "name": "Call child", "type": "skill", "refId": "not-provided"}]}
    )
    result = await execute_skill(parent_spec, {}, HeuristicRuntimeModelClient(), child_skills={})

    assert result.status == "failed"
    assert "not-provided" in result.steps[0].error


@pytest.mark.asyncio
async def test_skill_step_propagates_child_failure():
    failing_child = spec_with(
        name="Failing Child",
        execution={"steps": [{"id": "x", "name": "X", "type": "condition"}]},  # unsupported -> always fails
    )
    parent_spec = spec_with(
        execution={"steps": [{"id": "call-child", "name": "Call child", "type": "skill", "refId": "child-1"}]}
    )
    child_skills = {"child-1": ChildSkillRef(skillId="child-1", skillVersionId="v-1", spec=failing_child)}

    result = await execute_skill(parent_spec, {}, HeuristicRuntimeModelClient(), child_skills=child_skills)

    assert result.status == "failed"
    assert "child-1" in result.steps[0].error


@pytest.mark.asyncio
async def test_nested_skill_depth_limit_is_enforced():
    # maxNestedSkillDepth=2 on the OUTER spec_with default (BASE_SPEC), but
    # we set it to 1 here so a grandchild call is rejected even though it
    # IS present in the child_skills map.
    grandchild = spec_with(name="Grandchild", execution={"steps": [{"id": "g", "name": "G", "type": "transform"}]})
    child = spec_with(
        name="Child",
        execution={"steps": [{"id": "call-grandchild", "name": "Call grandchild", "type": "skill", "refId": "grandchild-1"}]},
    )
    parent_spec = spec_with(
        runtime={"timeoutSec": 30, "retryCount": 1, "maxToolCalls": 5, "maxNestedSkillDepth": 1},
        execution={"steps": [{"id": "call-child", "name": "Call child", "type": "skill", "refId": "child-1"}]},
    )
    child_skills = {
        "child-1": ChildSkillRef(skillId="child-1", skillVersionId="v-1", spec=child),
        "grandchild-1": ChildSkillRef(skillId="grandchild-1", skillVersionId="v-1", spec=grandchild),
    }

    result = await execute_skill(parent_spec, {}, HeuristicRuntimeModelClient(), child_skills=child_skills)

    assert result.status == "failed"
    assert "maxNestedSkillDepth" in result.steps[0].error
