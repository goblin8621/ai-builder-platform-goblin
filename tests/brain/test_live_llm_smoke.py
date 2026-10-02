"""Opt-in Smoke Test against a REAL LLM provider (P5 결정사항 #3).

Skipped by default — every other Runtime/Builder test uses a deterministic
Fake/Mock ModelClient and must pass with zero credentials. Set
LIVE_LLM_TEST=true and EITHER a real ANTHROPIC_API_KEY or OPENAI_API_KEY
to actually exercise Build -> Run -> Output Validation against whichever
real provider is configured — this goes through the same
`select_model_client` gate the running app uses (Phase 8 확장: Anthropic
takes priority if both are set), not a hardcoded provider.

    LIVE_LLM_TEST=true ANTHROPIC_API_KEY=sk-... pytest tests/brain/test_live_llm_smoke.py
    LIVE_LLM_TEST=true OPENAI_API_KEY=sk-... pytest tests/brain/test_live_llm_smoke.py

09번 문서 완료 기준 (Phase 8 E2E 이전 최소 1개 실제 Provider 연결)의
실행 지점. CI는 이 파일을 항상 스킵한 채로 통과해야 한다.
"""
from __future__ import annotations

import os

import pytest

from app.common.config import load_settings
from app.common.models.interface import ModelClient, ModelCompletionRequest, ModelCompletionResult
from app.common.models.selection import select_model_client
from app.skills.builder_service import BuilderInput, build_skill
from app.skills.execution_engine import execute_skill

pytestmark = pytest.mark.skipif(
    os.environ.get("LIVE_LLM_TEST") != "true",
    reason="LIVE_LLM_TEST != true — opt-in only, never runs in ordinary CI",
)


class _NoCredentialsFallback(ModelClient):
    """Never actually selected — only satisfies select_model_client's
    signature. If this test reaches it, no real API key was configured."""

    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResult:  # pragma: no cover
        raise AssertionError("No real ANTHROPIC_API_KEY or OPENAI_API_KEY configured for LIVE_LLM_TEST")


@pytest.mark.asyncio
async def test_build_and_run_a_real_skill_with_a_live_provider():
    settings = load_settings()
    assert settings.anthropic_api_key or settings.openai_api_key, (
        "ANTHROPIC_API_KEY or OPENAI_API_KEY must be set when LIVE_LLM_TEST=true"
    )
    client = select_model_client(settings, _NoCredentialsFallback())

    builder_input = BuilderInput(request="입력받은 한국어 문장을 자연스러운 영어로 번역하는 Skill 만들어줘")
    builder_output = await build_skill(builder_input, client, settings.builder_model_id)
    assert builder_output.action == "draft"
    assert builder_output.spec is not None

    run_result = await execute_skill(builder_output.spec, {"text": "안녕하세요"}, client, settings.default_run_model_id)
    assert run_result.status == "completed"
    assert run_result.output
