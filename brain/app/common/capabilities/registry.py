"""Capability Registry (Common Foundation).

Declares which platform Capabilities (01/03번: webSearch, imageGeneration,
codeExecution, dataAnalysis, fileAnalysis, knowledgeSearch, mcp) are
actually supported by this deployment. Builder must only let a Skill
Spec enable a Capability that this registry reports as supported
(03번: 서버 비지원 Capability 활성화 거부).

Phase 1: static, hardcoded-false registry — no Capability wired to a real
implementation yet.

Phase 6: `codeExecution` / `dataAnalysis` / `fileAnalysis` now have real
(if intentionally scoped) implementations — app/tools/executors.py's
`python-data-analysis` (via the Sandbox) and `file-parser`, and
app/rag/vectorizer.py's local search for `knowledgeSearch` — so those
flags flip to true. `webSearch` / `imageGeneration` / `mcp` stay false:
genuinely nothing implements them (no external service integration this
phase, consistent with this project's standing rule).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CapabilityFlags:
    web_search: bool = False
    image_generation: bool = False
    code_execution: bool = True
    data_analysis: bool = True
    file_analysis: bool = True
    knowledge_search: bool = True
    mcp: bool = False


class CapabilityRegistry:
    def __init__(self, flags: CapabilityFlags | None = None) -> None:
        self._flags = flags or CapabilityFlags()

    def supported(self) -> CapabilityFlags:
        return self._flags

    def is_supported(self, capability: str) -> bool:
        return bool(getattr(self._flags, capability, False))
