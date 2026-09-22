"""Human Approval interface (Common Foundation).

Phase 1 scope: interface/contract only. Real waiting_approval persistence
and approve/reject wiring is implemented in Phase 6 alongside the
Execution Engine (08번). Defined now so Runtime step design in Phase 5
can already depend on this seam instead of inventing an ad-hoc one later.

Contract: a Step with approvalRequired=true must request approval
through this interface and must NOT call any Tool/side-effect before
an "approved" decision comes back (08번: 승인 전 Side Effect 차단).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum


class ApprovalDecision(str, Enum):
    APPROVED = "approved"
    REJECTED = "rejected"
    PENDING = "pending"


@dataclass(frozen=True)
class ApprovalRequest:
    run_id: str
    step_id: str
    reason: str


class ApprovalGate(ABC):
    @abstractmethod
    async def request(self, request: ApprovalRequest) -> None:
        """Marks the run/step as waiting_approval and emits approval_required."""

    @abstractmethod
    async def get_decision(self, run_id: str, step_id: str) -> ApprovalDecision:
        ...
