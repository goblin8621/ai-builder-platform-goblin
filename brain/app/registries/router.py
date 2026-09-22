"""Read-only Registry endpoints (Phase 3: Registry / Skill CRUD).

BFF proxies these (bff/src/registries/routes.ts) so Skill CRUD can run
Registry Validation (03번: "Registry에 없는 model/tool ID 거부",
"서버 비지원 Capability 활성화 거부") against real data instead of
hardcoding the same catalog in two places.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.common.capabilities.registry import CapabilityRegistry
from app.common.models.static_registry import StaticModelRegistry
from app.common.tools.static_registry import StaticToolRegistry

router = APIRouter()

_model_registry = StaticModelRegistry()
_tool_registry = StaticToolRegistry()
_capability_registry = CapabilityRegistry()  # Phase 3: every flag stays False — no capability has real execution yet.


class ModelDescriptorOut(BaseModel):
    modelId: str
    displayName: str
    provider: str


class ToolDescriptorOut(BaseModel):
    toolId: str
    displayName: str
    inputSchema: dict[str, Any]
    outputSchema: dict[str, Any]


class CapabilityFlagsOut(BaseModel):
    webSearch: bool
    imageGeneration: bool
    codeExecution: bool
    dataAnalysis: bool
    fileAnalysis: bool
    knowledgeSearch: bool
    mcp: bool


class ModelsResponse(BaseModel):
    models: list[ModelDescriptorOut]


class ToolsResponse(BaseModel):
    tools: list[ToolDescriptorOut]


class CapabilitiesResponse(BaseModel):
    capabilities: CapabilityFlagsOut


@router.get("/models", response_model=ModelsResponse)
async def list_models() -> ModelsResponse:
    return ModelsResponse(
        models=[
            ModelDescriptorOut(modelId=m.model_id, displayName=m.display_name, provider=m.provider)
            for m in _model_registry.list_available()
        ]
    )


@router.get("/tools", response_model=ToolsResponse)
async def list_tools() -> ToolsResponse:
    return ToolsResponse(
        tools=[
            ToolDescriptorOut(
                toolId=t.tool_id,
                displayName=t.display_name,
                inputSchema=t.input_schema,
                outputSchema=t.output_schema,
            )
            for t in _tool_registry.list_available()
        ]
    )


@router.get("/capabilities", response_model=CapabilitiesResponse)
async def get_capabilities() -> CapabilitiesResponse:
    flags = _capability_registry.supported()
    return CapabilitiesResponse(
        capabilities=CapabilityFlagsOut(
            webSearch=flags.web_search,
            imageGeneration=flags.image_generation,
            codeExecution=flags.code_execution,
            dataAnalysis=flags.data_analysis,
            fileAnalysis=flags.file_analysis,
            knowledgeSearch=flags.knowledge_search,
            mcp=flags.mcp,
        )
    )
