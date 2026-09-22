"""Concrete ToolExecutor implementations for the Phase 3 static Tool
Registry catalog (file-parser, python-data-analysis, service-status).

All three are deliberately LOCAL and SELF-CONTAINED — no outbound network
calls, consistent with this project's standing rule that real external
service integration is out of scope until a later, separate phase.
`service-status` returns a clearly-labelled simulated response; swapping
in a real monitoring integration later only means a new ToolExecutor
implementation behind the same interface, no Runtime changes.

A Skill can only SELECT a Tool by `refId` (already Registry-validated at
save time, 03번) — it never supplies its own code. `python-data-analysis`
runs a FIXED, reviewed script; only the DATA (via stdin) is
Skill-Run-supplied, executed through the Sandbox boundary (09번 금지
사항 #10: "Host에서 Code Execution 직접 실행" 금지).
"""
from __future__ import annotations

import csv
import io
import json
from typing import Any

from app.common.errors import AppError
from app.common.sandbox.interface import Sandbox, SandboxExecutionRequest, SandboxLimits
from app.common.tools.interface import ToolCallRequest, ToolCallResult, ToolExecutor


def _parse_file(tool_input: dict[str, Any]) -> dict[str, Any]:
    content = tool_input.get("content")
    if not isinstance(content, str):
        raise AppError("validation_error", 'file-parser requires a string "content" field (CSV text)')
    reader = csv.DictReader(io.StringIO(content))
    rows = list(reader)
    return {"columns": list(reader.fieldnames or []), "rows": rows, "rowCount": len(rows)}


def _service_status(tool_input: dict[str, Any]) -> dict[str, Any]:
    service_id = tool_input.get("serviceId", "unknown")
    # Deterministic, clearly-simulated example response (module docstring).
    return {
        "serviceId": service_id,
        "status": "healthy",
        "metrics": {"latencyMs": 42, "errorRate": 0.0},
        "simulated": True,
    }


_ANALYSIS_SCRIPT = r"""
import json, sys, statistics
from collections import defaultdict

data = json.loads(sys.stdin.read())
operation = data["operation"]
rows = data["rows"]

if operation == "monthly_sum":
    sums = defaultdict(float)
    for row in rows:
        sums[row["month"]] += float(row["amount"])
    result = {"monthlySums": dict(sums)}
elif operation == "detect_outliers":
    values = [float(row["amount"]) for row in rows]
    mean = statistics.fmean(values) if values else 0.0
    stdev = statistics.pstdev(values) if len(values) > 1 else 0.0
    outliers = []
    for row in rows:
        amount = float(row["amount"])
        z = (amount - mean) / stdev if stdev > 0 else 0.0
        if abs(z) > 2:
            outliers.append({**row, "zScore": z})
    result = {"mean": mean, "stdev": stdev, "outliers": outliers}
else:
    raise SystemExit(f"unknown operation: {operation}")

print(json.dumps(result))
"""


async def _python_data_analysis(tool_input: dict[str, Any], sandbox: Sandbox) -> dict[str, Any]:
    operation = tool_input.get("operation")
    if operation not in ("monthly_sum", "detect_outliers"):
        raise AppError(
            "validation_error",
            'python-data-analysis requires "operation" to be "monthly_sum" or "detect_outliers"',
        )
    payload = json.dumps({"operation": operation, "rows": tool_input.get("rows", [])}).encode("utf-8")
    result = await sandbox.execute(
        SandboxExecutionRequest(
            code=_ANALYSIS_SCRIPT,
            language="python",
            limits=SandboxLimits(timeout_sec=10, memory_limit_mb=256, output_limit_kb=256),
            stdin=payload,
        )
    )
    if result.timed_out or result.exit_code != 0:
        raise AppError(
            "internal_error",
            f"python-data-analysis sandbox execution failed (exit={result.exit_code}): {result.stderr.strip()}",
        )
    return json.loads(result.stdout)


class StaticToolExecutor(ToolExecutor):
    def __init__(self, sandbox: Sandbox) -> None:
        self._sandbox = sandbox

    async def call(self, request: ToolCallRequest) -> ToolCallResult:
        if request.tool_id == "file-parser":
            return ToolCallResult(output=_parse_file(request.input))
        if request.tool_id == "service-status":
            return ToolCallResult(output=_service_status(request.input))
        if request.tool_id == "python-data-analysis":
            return ToolCallResult(output=await _python_data_analysis(request.input, self._sandbox))
        raise AppError("not_found", f'Tool "{request.tool_id}" has no execution implementation')
