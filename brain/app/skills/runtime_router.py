"""Skill Runtime HTTP surface (internal BFF <-> Brain contract).

BFF has already loaded+pinned the Skill Version and validated the Run
Input against `inputSchema` before calling this — this router only
executes the already-validated (spec, input) pair and returns the full
result. It never touches a database (Brain has none); BFF persists
`skill_runs` / `skill_run_steps` from the returned RunResult, including
walking `StepResult.childRun` trees for Nested Skill (parent/child Run
linkage, 02번).

BFF is also responsible for resolving `childSkills` (version-pinned child
Skill specs, up to `maxNestedSkillDepth`) and `knowledgeCorpus` (in-scope
document chunk text) BEFORE calling this endpoint, since Brain has no
database access (06번 역할 분리).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.common.config import settings
from app.common.context.request_context import RequestContext, get_request_context
from app.common.models.heuristic_runtime_client import HeuristicRuntimeModelClient
from app.common.models.selection import select_model_client
from app.sandbox.subprocess_sandbox import SubprocessSandbox
from app.skills.execution_engine import ChildSkillRef, RunResult, execute_skill
from app.tools.executors import StaticToolExecutor

router = APIRouter(prefix="/runtime")

# See app/skills/router.py for why this indirection exists — same gate,
# same dev/test-only Heuristic fallback rule (P5 결정사항).
_model_client = select_model_client(settings, HeuristicRuntimeModelClient())
_tool_executor = StaticToolExecutor(SubprocessSandbox())


class ChildSkillBody(BaseModel):
    skillVersionId: str
    spec: dict[str, Any]


class KnowledgeChunkBody(BaseModel):
    documentId: str
    chunkIndex: int
    content: str


class ExecuteRequestBody(BaseModel):
    spec: dict[str, Any]
    input: dict[str, Any]
    childSkills: dict[str, ChildSkillBody] = {}
    knowledgeCorpus: list[KnowledgeChunkBody] = []
    # Human Approval resume (08번 7.): all three are set together by BFF
    # when resuming a Run that was previously `waiting_approval`; omitted
    # for a fresh Run.
    resumeFromStepId: str | None = None
    priorStepOutputs: dict[str, dict[str, Any]] = {}
    approvedStepId: str | None = None


@router.post("/execute", response_model=RunResult)
async def execute(
    body: ExecuteRequestBody,
    context: RequestContext = Depends(get_request_context),
) -> RunResult:
    child_skills = {
        skill_id: ChildSkillRef(skillId=skill_id, skillVersionId=ref.skillVersionId, spec=ref.spec)
        for skill_id, ref in body.childSkills.items()
    }
    knowledge_corpus = [chunk.model_dump() for chunk in body.knowledgeCorpus]

    return await execute_skill(
        body.spec,
        body.input,
        _model_client,
        settings.default_run_model_id,
        tool_executor=_tool_executor,
        child_skills=child_skills,
        knowledge_corpus=knowledge_corpus,
        resume_from_step_id=body.resumeFromStepId,
        prior_step_outputs=body.priorStepOutputs,
        approved_step_id=body.approvedStepId,
    )
