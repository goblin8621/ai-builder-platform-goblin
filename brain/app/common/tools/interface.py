"""Tool Registry / Executor interface (Common Foundation).

Phase 1 scope: interface/contract only. Real Tool/MCP wiring happens in
Phase 6 (Extended Runtime). Kept generic so it is not strongly coupled
to Skill Step execution — a future Agent Runtime reuses the same
registry/executor (06번 원칙: Tool Executor를 Skill에 과도하게 결합하지 않음).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class ToolDescriptor:
    tool_id: str
    display_name: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    # Phase 9 (Skill Export, 10번 §10): Provider-neutral description of what
    # the tool does and how it is reached, so an Export can record it as a
    # Portable Requirement. `protocol` is "builtin" (platform-native) or "mcp".
    description: str = ""
    protocol: str = "builtin"


@dataclass(frozen=True)
class ToolCallRequest:
    tool_id: str
    input: dict[str, Any]
    timeout_sec: Optional[float] = None


@dataclass(frozen=True)
class ToolCallResult:
    output: dict[str, Any]
    raw: Optional[dict[str, Any]] = None


class ToolRegistry(ABC):
    """Builder/Runtime must only reference tools through toolId values this
    registry knows about (03번: Registry에 없는 Tool ID 거부)."""

    @abstractmethod
    def list_available(self) -> list[ToolDescriptor]:
        ...

    @abstractmethod
    def exists(self, tool_id: str) -> bool:
        ...


class ToolExecutor(ABC):
    """Executes a resolved tool call. Timeout/failure handling here feeds
    the Skill Runtime's retry/fallback/skip/fail policy (08번)."""

    @abstractmethod
    async def call(self, request: ToolCallRequest) -> ToolCallResult:
        ...
