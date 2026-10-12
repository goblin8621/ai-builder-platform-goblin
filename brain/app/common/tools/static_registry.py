"""Static, hardcoded ToolRegistry implementation.

Phase 3 scope: gives Builder/CRUD Registry Validation something real to
check a Step's `refId` against. No actual tool execution is wired yet —
that is ToolExecutor's job, still unimplemented (Phase 6).

Catalog entries match the tool refIds used in 00번 유즈케이스 examples
(CSV 분석 / 서비스 상태 조회) and tests/contract fixtures.
"""
from __future__ import annotations

from app.common.tools.interface import ToolDescriptor, ToolRegistry

_GENERIC_OBJECT_SCHEMA = {"type": "object"}

_CATALOG: list[ToolDescriptor] = [
    ToolDescriptor(
        tool_id="file-parser",
        display_name="File Parser",
        description="Parses CSV text into columns and rows.",
        input_schema=_GENERIC_OBJECT_SCHEMA,
        output_schema=_GENERIC_OBJECT_SCHEMA,
    ),
    ToolDescriptor(
        tool_id="python-data-analysis",
        display_name="Python Data Analysis",
        description="Runs fixed, reviewed analysis operations on tabular data inside an isolated sandbox.",
        input_schema=_GENERIC_OBJECT_SCHEMA,
        output_schema=_GENERIC_OBJECT_SCHEMA,
    ),
    ToolDescriptor(
        tool_id="service-status",
        display_name="Service Status Checker",
        description="Returns the status of a named service (simulated response on this platform).",
        input_schema=_GENERIC_OBJECT_SCHEMA,
        output_schema=_GENERIC_OBJECT_SCHEMA,
    ),
]


class StaticToolRegistry(ToolRegistry):
    def list_available(self) -> list[ToolDescriptor]:
        return list(_CATALOG)

    def exists(self, tool_id: str) -> bool:
        return any(t.tool_id == tool_id for t in _CATALOG)
