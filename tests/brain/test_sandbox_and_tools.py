import json

import pytest

from app.common.sandbox.interface import SandboxExecutionRequest, SandboxLimits
from app.common.tools.interface import ToolCallRequest
from app.sandbox.subprocess_sandbox import SubprocessSandbox
from app.tools.executors import StaticToolExecutor


@pytest.mark.asyncio
async def test_sandbox_runs_simple_script_via_stdin():
    sandbox = SubprocessSandbox()
    result = await sandbox.execute(
        SandboxExecutionRequest(
            code="import sys, json; print(json.dumps({'echo': json.loads(sys.stdin.read())}))",
            language="python",
            limits=SandboxLimits(timeout_sec=5),
            stdin=b'{"x": 1}',
        )
    )
    assert result.exit_code == 0
    assert not result.timed_out
    assert json.loads(result.stdout) == {"echo": {"x": 1}}


@pytest.mark.asyncio
async def test_sandbox_enforces_timeout():
    sandbox = SubprocessSandbox()
    result = await sandbox.execute(
        SandboxExecutionRequest(
            code="import time; time.sleep(5)",
            language="python",
            limits=SandboxLimits(timeout_sec=0.2),
        )
    )
    assert result.timed_out is True
    assert result.exit_code == -1


@pytest.mark.asyncio
async def test_sandbox_truncates_oversized_output():
    sandbox = SubprocessSandbox()
    result = await sandbox.execute(
        SandboxExecutionRequest(
            code="print('x' * 100000)",
            language="python",
            limits=SandboxLimits(timeout_sec=5, output_limit_kb=1),
        )
    )
    assert len(result.stdout) <= 1024


@pytest.mark.asyncio
async def test_sandbox_rejects_non_python_language():
    sandbox = SubprocessSandbox()
    with pytest.raises(ValueError):
        await sandbox.execute(
            SandboxExecutionRequest(code="echo hi", language="bash", limits=SandboxLimits(timeout_sec=1))
        )


@pytest.mark.asyncio
async def test_file_parser_tool_parses_csv():
    executor = StaticToolExecutor(SubprocessSandbox())
    result = await executor.call(
        ToolCallRequest(tool_id="file-parser", input={"content": "month,amount\n2026-01,100\n2026-02,200\n"})
    )
    assert result.output["rowCount"] == 2
    assert result.output["columns"] == ["month", "amount"]


@pytest.mark.asyncio
async def test_service_status_tool_returns_simulated_status():
    executor = StaticToolExecutor(SubprocessSandbox())
    result = await executor.call(ToolCallRequest(tool_id="service-status", input={"serviceId": "svc-1"}))
    assert result.output["status"] == "healthy"
    assert result.output["simulated"] is True


@pytest.mark.asyncio
async def test_python_data_analysis_monthly_sum():
    executor = StaticToolExecutor(SubprocessSandbox())
    rows = [
        {"month": "2026-01", "amount": 100},
        {"month": "2026-01", "amount": 50},
        {"month": "2026-02", "amount": 200},
    ]
    result = await executor.call(
        ToolCallRequest(tool_id="python-data-analysis", input={"operation": "monthly_sum", "rows": rows})
    )
    assert result.output["monthlySums"] == {"2026-01": 150.0, "2026-02": 200.0}


@pytest.mark.asyncio
async def test_python_data_analysis_detect_outliers():
    executor = StaticToolExecutor(SubprocessSandbox())
    rows = [{"month": "m", "amount": v} for v in [10, 11, 9, 10, 11, 1000]]
    result = await executor.call(
        ToolCallRequest(tool_id="python-data-analysis", input={"operation": "detect_outliers", "rows": rows})
    )
    outlier_amounts = [o["amount"] for o in result.output["outliers"]]
    assert 1000 in outlier_amounts


@pytest.mark.asyncio
async def test_python_data_analysis_rejects_unknown_operation():
    from app.common.errors import AppError

    executor = StaticToolExecutor(SubprocessSandbox())
    with pytest.raises(AppError):
        await executor.call(ToolCallRequest(tool_id="python-data-analysis", input={"operation": "bogus", "rows": []}))


@pytest.mark.asyncio
async def test_unknown_tool_id_raises_not_found():
    from app.common.errors import AppError

    executor = StaticToolExecutor(SubprocessSandbox())
    with pytest.raises(AppError) as exc_info:
        await executor.call(ToolCallRequest(tool_id="does-not-exist", input={}))
    assert exc_info.value.code == "not_found"
