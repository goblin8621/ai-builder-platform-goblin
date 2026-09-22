"""Knowledge / RAG interface (Common Foundation).

Phase 1 scope: interface/contract only. Real document indexing/search is
wired from Phase 6 onward. Search must always be scoped to
workspaceId + documentIds (02번: 실제 검색 범위는 항상 workspaceId + documentIds로
제한) — the interface takes workspace_id explicitly so no implementation
can accidentally search across workspaces.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class KnowledgeSearchRequest:
    workspace_id: str
    query: str
    document_ids: Optional[list[str]] = None
    top_k: int = 5


@dataclass(frozen=True)
class KnowledgeChunk:
    document_id: str
    chunk_index: int
    content: str
    score: float


class KnowledgeService(ABC):
    @abstractmethod
    async def search(self, request: KnowledgeSearchRequest) -> list[KnowledgeChunk]:
        ...
