"""Skill Export HTTP surface (internal BFF <-> Brain contract, Phase 9).

BFF has already loaded the pinned Skill Version, resolved + locked Child
Skills, and verified Document permissions (workspace ∧ document access ∧
export_allowed) before calling this — Brain is a pure, DB-less transformer
(06번 역할 분리), exactly like /runtime/execute.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.common.context.request_context import RequestContext, get_request_context

from .adapters import has_adapter
from .models import (
    ExportCompileRequest,
    ExportCompileResponse,
    ExportFormatDescriptor,
    ExportTargetDescriptor,
    ExportTargetsResponse,
)
from .pipeline import build_export
from .profiles import list_targets

router = APIRouter(prefix="/exports")


@router.post("/compile", response_model=ExportCompileResponse)
async def compile_export(
    body: ExportCompileRequest,
    context: RequestContext = Depends(get_request_context),
) -> ExportCompileResponse:
    return build_export(body)


@router.get("/targets", response_model=ExportTargetsResponse)
async def list_export_targets() -> ExportTargetsResponse:
    """Every supported target/format. `adapterAvailable` tells clients which ones can actually
    export, so "unsupported target" and "adapter missing" stay distinguishable (and a client
    never offers a format it cannot use)."""
    return ExportTargetsResponse(
        targets=[
            ExportTargetDescriptor(
                id=target.id,
                displayName=target.display_name,
                formats=[
                    ExportFormatDescriptor(
                        id=fmt.id,
                        displayName=fmt.display_name,
                        contentType=fmt.content_type,
                        targetOptimized=fmt.target_optimized,
                        embedsKnowledge=fmt.embeds_knowledge,
                        embedsChildSkills=fmt.embeds_children,
                        embedsSourceSpec=fmt.embeds_source_spec,
                        adapterAvailable=has_adapter(target.id, fmt.id),
                    )
                    for fmt in target.formats
                ],
            )
            for target in list_targets()
        ]
    )
