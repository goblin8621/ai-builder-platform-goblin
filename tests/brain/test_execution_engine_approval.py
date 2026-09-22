import pytest

from app.common.models.heuristic_runtime_client import HeuristicRuntimeModelClient
from app.common.tools.interface import ToolCallRequest, ToolCallResult, ToolExecutor
from app.skills.execution_engine import execute_skill

BASE_SPEC = {
    "schemaVersion": "1.0",
    "name": "Approval Test Skill",
    "description": "test",
    "skillType": "workflow",
    "inputSchema": {"type": "object", "properties": {}},
    "outputSchema": {"type": "object", "required": ["done"], "properties": {"done": {"type": "boolean"}}},
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
    "execution": {
        "steps": [
            {"id": "check", "name": "Check status", "type": "transform"},
            {"id": "restart", "name": "Restart service", "type": "tool", "refId": "restart-tool", "approvalRequired": True},
            {"id": "recheck", "name": "Recheck status", "type": "transform", "inputMap": {"done": True}},
        ]
    },
    "runtime": {"timeoutSec": 30, "retryCount": 1, "maxToolCalls": 5, "maxNestedSkillDepth": 0},
    "guardrails": [],
    "usageExamples": [],
    "metadata": {"category": "test", "tags": []},
}


class RecordingToolExecutor(ToolExecutor):
    def __init__(self):
        self.calls = 0

    async def call(self, request: ToolCallRequest) -> ToolCallResult:
        self.calls += 1
        return ToolCallResult(output={"restarted": True})


@pytest.mark.asyncio
async def test_pauses_before_the_approval_required_step_without_executing_it():
    tool_executor = RecordingToolExecutor()
    result = await execute_skill(BASE_SPEC, {}, HeuristicRuntimeModelClient(), tool_executor=tool_executor)

    assert result.status == "waiting_approval"
    assert result.pendingApproval.stepId == "restart"
    assert tool_executor.calls == 0  # the side-effecting Tool was NEVER called before approval
    assert [s.stepId for s in result.steps] == ["check"]  # only the step BEFORE the gate ran


@pytest.mark.asyncio
async def test_resume_with_approved_step_id_executes_it_and_continues():
    tool_executor = RecordingToolExecutor()

    first = await execute_skill(BASE_SPEC, {}, HeuristicRuntimeModelClient(), tool_executor=tool_executor)
    assert first.status == "waiting_approval"

    prior_outputs = {s.stepId: s.output for s in first.steps if s.status == "completed"}
    resumed = await execute_skill(
        BASE_SPEC,
        {},
        HeuristicRuntimeModelClient(),
        tool_executor=tool_executor,
        resume_from_step_id=first.pendingApproval.stepId,
        prior_step_outputs=prior_outputs,
        approved_step_id=first.pendingApproval.stepId,
    )

    assert resumed.status == "completed"
    assert resumed.output == {"done": True}
    assert tool_executor.calls == 1
    assert [s.stepId for s in resumed.steps] == ["restart", "recheck"]


@pytest.mark.asyncio
async def test_a_second_approval_gate_pauses_again_after_resuming_the_first():
    spec = {
        **BASE_SPEC,
        "execution": {
            "steps": [
                {"id": "gate1", "name": "Gate 1", "type": "tool", "refId": "x", "approvalRequired": True},
                {"id": "gate2", "name": "Gate 2", "type": "tool", "refId": "x", "approvalRequired": True},
            ]
        },
    }
    tool_executor = RecordingToolExecutor()

    first = await execute_skill(spec, {}, HeuristicRuntimeModelClient(), tool_executor=tool_executor)
    assert first.status == "waiting_approval"
    assert first.pendingApproval.stepId == "gate1"

    second = await execute_skill(
        spec,
        {},
        HeuristicRuntimeModelClient(),
        tool_executor=tool_executor,
        resume_from_step_id="gate1",
        prior_step_outputs={},
        approved_step_id="gate1",
    )

    assert second.status == "waiting_approval"
    assert second.pendingApproval.stepId == "gate2"
    assert tool_executor.calls == 1  # only gate1 ran so far
