"""Model Registry / Client interface (Common Foundation).

Phase 1 scope: interface/contract only. No concrete LLM provider is
wired yet — that happens once Skill Runtime (Phase 5+) needs to call
a model. Kept independent of any specific Skill so a future Agent
Runtime can reuse it (10번/06번 원칙: Skill 전용 구조로 만들지 않음).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class ModelDescriptor:
    """What the Model Registry exposes about a usable model."""

    model_id: str
    display_name: str
    provider: str


@dataclass(frozen=True)
class ModelCompletionRequest:
    model_id: str
    messages: list[dict[str, Any]]
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None


@dataclass(frozen=True)
class ModelCompletionResult:
    text: str
    raw: Optional[dict[str, Any]] = None


class ModelRegistry(ABC):
    """Resolves which models are available/allowed. Builder/Runtime must
    only ever reference models through modelId values this registry knows
    about (03번: Registry에 없는 model ID 거부)."""

    @abstractmethod
    def list_available(self) -> list[ModelDescriptor]:
        ...

    @abstractmethod
    def exists(self, model_id: str) -> bool:
        ...


class ModelClient(ABC):
    """Executes a completion against a resolved model. Secrets/endpoints
    are resolved internally here, never stored in a Skill Spec (02번)."""

    @abstractmethod
    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResult:
        ...
