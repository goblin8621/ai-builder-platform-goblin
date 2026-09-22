"""Sandbox interface (Common Foundation).

Phase 1 scope: interface/contract only, per 06번 문서 ("Sandbox 구현 기술은
현재 고정하지 않고 Interface/Contract를 먼저 정의"). The actual isolation
technology (Docker/gVisor/Firecracker/...) is chosen when Code Execution
is implemented (Phase 6). All Code Execution must go through this
boundary — never executed directly on the host (09번 금지사항 #10).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class SandboxLimits:
    timeout_sec: float
    cpu_limit: Optional[float] = None
    memory_limit_mb: Optional[int] = None
    file_limit_mb: Optional[int] = None
    network_policy: str = "deny"
    output_limit_kb: Optional[int] = None


@dataclass(frozen=True)
class SandboxExecutionRequest:
    code: str
    language: str
    limits: SandboxLimits
    input_files: Optional[dict[str, bytes]] = None
    # Data piped to the process's stdin — the safe way to pass untrusted
    # DATA into a fixed, trusted `code` string (avoids embedding data as
    # literal source text). Phase 6's concrete Tool implementations always
    # use this rather than string-formatting data into `code`.
    stdin: Optional[bytes] = None


@dataclass(frozen=True)
class SandboxExecutionResult:
    exit_code: int
    stdout: str
    stderr: str
    output_files: Optional[dict[str, bytes]] = None
    timed_out: bool = False


class Sandbox(ABC):
    @abstractmethod
    async def execute(self, request: SandboxExecutionRequest) -> SandboxExecutionResult:
        ...
