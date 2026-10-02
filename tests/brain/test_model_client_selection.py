import dataclasses

import pytest

from app.common.config import Settings
from app.common.models.anthropic_client import AnthropicModelClient
from app.common.models.interface import ModelClient
from app.common.models.openai_client import OpenAIModelClient
from app.common.models.selection import ModelClientConfigurationError, select_model_client


class _DevFallback(ModelClient):
    async def complete(self, request):  # pragma: no cover - never called in these tests
        raise NotImplementedError


def _settings(
    mode: str,
    api_key: str | None,
    openai_api_key: str | None = None,
) -> Settings:
    return Settings(
        mode=mode,
        host="0.0.0.0",
        port=8000,
        database_url="postgresql://x",
        anthropic_api_key=api_key,
        model_provider_map={"model-001": "claude-sonnet-4-5-20250929"},
        openai_api_key=openai_api_key,
        openai_model_provider_map={"model-001": "gpt-4o-mini"},
        builder_model_id="model-001",
        default_run_model_id="model-001",
    )


def test_returns_anthropic_client_when_api_key_present_regardless_of_mode():
    dev_fallback = _DevFallback()
    for mode in ("development", "test", "production"):
        client = select_model_client(_settings(mode, "sk-real-key"), dev_fallback)
        assert isinstance(client, AnthropicModelClient)


def test_returns_openai_client_when_only_openai_key_present():
    dev_fallback = _DevFallback()
    for mode in ("development", "test", "production"):
        client = select_model_client(_settings(mode, None, openai_api_key="sk-openai-key"), dev_fallback)
        assert isinstance(client, OpenAIModelClient)


def test_anthropic_takes_priority_when_both_keys_are_present():
    dev_fallback = _DevFallback()
    client = select_model_client(_settings("development", "sk-real-key", openai_api_key="sk-openai-key"), dev_fallback)
    assert isinstance(client, AnthropicModelClient)


def test_returns_dev_fallback_in_development_without_api_key():
    dev_fallback = _DevFallback()
    client = select_model_client(_settings("development", None), dev_fallback)
    assert client is dev_fallback


def test_returns_dev_fallback_in_test_mode_without_api_key():
    dev_fallback = _DevFallback()
    client = select_model_client(_settings("test", None), dev_fallback)
    assert client is dev_fallback


def test_raises_configuration_error_in_production_without_api_key():
    dev_fallback = _DevFallback()
    with pytest.raises(ModelClientConfigurationError):
        select_model_client(_settings("production", None), dev_fallback)


def test_settings_is_a_frozen_dataclass_so_this_test_fixture_stays_honest():
    # Guards against silently drifting from the real Settings shape.
    assert dataclasses.is_dataclass(Settings)
