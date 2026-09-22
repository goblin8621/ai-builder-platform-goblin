"""Subprocess-based Sandbox — Phase 6's concrete choice for the interface
defined in Phase 1 (`app/common/sandbox/interface.py`).

SECURITY BOUNDARY (read before reusing this for anything beyond this
platform's own fixed, non-user-authored Tool scripts):
    This is PROCESS-level isolation only — a `python -I` subprocess with a
    stripped environment, an RLIMIT_AS memory cap, a wall-clock timeout,
    and truncated captured output. It is NOT container or VM isolation
    (Docker/gVisor/Firecracker), does not use Linux namespaces or seccomp,
    and its `network_policy` enforcement is best-effort (env stripping
    only — it does not block raw sockets). It is suitable for running
    THIS PLATFORM'S OWN fixed, reviewed scripts (see app/tools/executors.py)
    with untrusted DATA, in a trusted development/demo environment. It is
    NOT hardened enough for arbitrary untrusted CODE from an adversarial
    user in a multi-tenant production deployment — that still requires the
    container/VM-level isolation 06번 left open ("실제 격리 기술은 Code
    Execution 구현 시점에 결정"). This is a Phase 6 scoping decision to
    document explicitly, not a claim that the choice is final.

Enforcement reliability:
    - timeout: reliable on every platform tested.
    - memory_limit_mb (RLIMIT_AS): reliable on Linux; observed to be
      rejected by the kernel on Darwin/macOS even when only lowering the
      limit, in which case it is silently skipped rather than aborting
      the whole sandbox call (see `_preexec_fn`). Do not rely on this
      limit alone on a macOS host.
    - output_limit_kb: always enforced (truncated after capture).
    - network_policy == "deny": best-effort env stripping only, does not
      block raw sockets.
"""
from __future__ import annotations

import asyncio
import sys

from app.common.sandbox.interface import Sandbox, SandboxExecutionRequest, SandboxExecutionResult

_DEFAULT_OUTPUT_LIMIT_KB = 64


def _preexec_fn(memory_limit_mb: int | None):
    def _apply() -> None:
        if memory_limit_mb is None:
            return
        import resource  # POSIX only; imported lazily so Windows dev boxes don't crash on import

        limit_bytes = memory_limit_mb * 1024 * 1024
        try:
            resource.setrlimit(resource.RLIMIT_AS, (limit_bytes, limit_bytes))
        except (ValueError, OSError):
            # Best-effort only (module docstring): some platforms (observed
            # on Darwin/macOS) reject RLIMIT_AS even when lowering it. A
            # preexec_fn exception would abort subprocess creation entirely,
            # which is worse than skipping this one limit — timeout and
            # output truncation still apply regardless.
            pass

    return _apply


class SubprocessSandbox(Sandbox):
    async def execute(self, request: SandboxExecutionRequest) -> SandboxExecutionResult:
        if request.language != "python":
            raise ValueError(f"SubprocessSandbox only supports language='python', got '{request.language}'")

        env = {"PATH": "/usr/bin:/bin"}  # stripped: no inherited secrets, no proxy env vars
        preexec = _preexec_fn(request.limits.memory_limit_mb) if sys.platform != "win32" else None

        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",  # isolated mode: ignore PYTHON* env vars, don't add script/user site dirs
            "-c",
            request.code,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            preexec_fn=preexec,
        )

        timed_out = False
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(input=request.stdin), timeout=request.limits.timeout_sec
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            stdout, stderr = b"", b"sandbox execution timed out"
            timed_out = True

        limit_bytes = (request.limits.output_limit_kb or _DEFAULT_OUTPUT_LIMIT_KB) * 1024
        return SandboxExecutionResult(
            exit_code=-1 if timed_out else (process.returncode or 0),
            stdout=stdout[:limit_bytes].decode("utf-8", errors="replace"),
            stderr=stderr[:limit_bytes].decode("utf-8", errors="replace"),
            timed_out=timed_out,
        )
