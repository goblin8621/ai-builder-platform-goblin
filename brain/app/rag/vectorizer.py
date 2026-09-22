"""Local, dependency-free text similarity for `knowledge` Step execution
(08번 RAG, Phase 6).

NOT a real embedding model — no external embedding provider is
configured (same constraint, same transparency, as the Builder/Runtime
Heuristic ModelClients). Uses a deterministic hashing-trick term-frequency
vector (fixed dimensionality, no vocabulary/training step) so both the
corpus chunks and the query can be scored by cosine similarity ENTIRELY
within a single Brain process/request, with no cross-language or
cross-request state to keep in sync. `document_chunks.embedding` (02번)
stays unused for now; swap in a real embedding provider by replacing
`_vectorize` and persisting it there to avoid recomputing on every search.

A deterministic FNV-1a hash is used instead of Python's built-in `hash()`,
which is randomized per-process (PYTHONHASHSEED) and would make results
depend on process restarts.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from typing import TypedDict

_DIMENSIONS = 256
_TOKEN_RE = re.compile(r"[\w가-힣]+")


class KnowledgeChunk(TypedDict):
    documentId: str
    chunkIndex: int
    content: str


class ScoredChunk(KnowledgeChunk):
    score: float


def _tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


def _fnv1a_bucket(token: str) -> int:
    h = 2166136261
    for ch in token:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h % _DIMENSIONS


def _vectorize(text: str) -> list[float]:
    counts = Counter(_fnv1a_bucket(tok) for tok in _tokenize(text))
    vector = [0.0] * _DIMENSIONS
    for bucket, count in counts.items():
        vector[bucket] = float(count)
    norm = math.sqrt(sum(v * v for v in vector))
    return [v / norm for v in vector] if norm > 0 else vector


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def search(query: str, corpus: list[KnowledgeChunk], top_k: int = 3) -> list[ScoredChunk]:
    """Returns the `top_k` highest-scoring chunks, highest first. An empty
    corpus returns an empty list — "no evidence found" is a legitimate,
    expected outcome (00번 유즈케이스 #2: "근거가 없으면 문서에서 확인할
    수 없다고 반환"), not an error."""
    if not corpus:
        return []
    query_vector = _vectorize(query)
    scored: list[ScoredChunk] = [
        {**item, "score": _cosine_similarity(query_vector, _vectorize(item["content"]))}  # type: ignore[typeddict-item]
        for item in corpus
    ]
    scored.sort(key=lambda c: c["score"], reverse=True)
    return scored[:top_k]
