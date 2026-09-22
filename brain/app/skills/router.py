"""Skill Builder HTTP surface (internal BFF <-> Brain contract, Phase 4).

BFF calls these after gathering `availableSkills` / `availableKnowledge`
from its own Postgres (Brain has no DB access) — see 06번 역할 분리.
BFF is responsible for re-validating and persisting the returned `spec`
through the same Phase 2/3 pipeline used for manually-submitted specs;
this router never writes to a database.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.common.config import settings
from app.common.context.request_context import RequestContext, get_request_context
from app.common.errors import AppError
from app.common.models.heuristic_client import HeuristicModelClient
from app.common.models.selection import select_model_client
from app.skills.builder_service import BuilderInput, BuilderOutput, build_skill, refine_skill

router = APIRouter(prefix="/builder")

# Mirrors bff's DevAuthContextProvider pattern: a clearly-labelled dev/test
# implementation is used until real credentials are configured, without any
# call site needing to change when they are. In production (BRAIN_ENV=
# production) with no ANTHROPIC_API_KEY, this raises at import time instead
# of silently using the Heuristic fallback (P5 결정사항).
_model_client = select_model_client(settings, HeuristicModelClient())


class BuilderRequestBody(BaseModel):
    request: str
    currentSpec: dict | None = None
    availableSkills: list[dict] = []
    availableKnowledge: list[dict] = []
    defaults: dict = {}


@router.post("/build", response_model=BuilderOutput)
async def build(
    body: BuilderRequestBody,
    context: RequestContext = Depends(get_request_context),
) -> BuilderOutput:
    if body.currentSpec is not None:
        raise AppError("validation_error", "POST /builder/build does not accept currentSpec — use /builder/refine")
    builder_input = BuilderInput.model_validate(body.model_dump())
    return await build_skill(builder_input, _model_client, settings.builder_model_id)


@router.post("/refine", response_model=BuilderOutput)
async def refine(
    body: BuilderRequestBody,
    context: RequestContext = Depends(get_request_context),
) -> BuilderOutput:
    if body.currentSpec is None:
        raise AppError("validation_error", "POST /builder/refine requires currentSpec")
    builder_input = BuilderInput.model_validate(body.model_dump())
    return await refine_skill(builder_input, _model_client, settings.builder_model_id)
