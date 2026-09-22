"""Streaming interface (Common Foundation).

Phase 1 scope: fixes the SkillEvent envelope (mirrors
contracts/common-types.ts SkillEvent / 05·08번 문서) and the publisher
seam. Brain emits events through this interface; BFF relays them to
clients over SSE (Web -> BFF -> SSE -> Client). No real Skill events
are produced yet — that starts in Phase 5/6 when the Execution Engine
exists.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional


@dataclass(frozen=True)
class SkillEvent:
    event: str
    run_id: str
    skill_id: str
    skill_version: int
    step_id: Optional[str] = None
    data: Optional[dict[str, Any]] = None
    timestamp: str = ""

    def __post_init__(self) -> None:
        if not self.timestamp:
            object.__setattr__(self, "timestamp", datetime.now(timezone.utc).isoformat())


class EventPublisher(ABC):
    @abstractmethod
    async def publish(self, event: SkillEvent) -> None:
        ...
