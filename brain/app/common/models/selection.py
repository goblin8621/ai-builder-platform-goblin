"""ModelClient selection gate (P5 결정사항 #3).

The dev/test Heuristic*ModelClient implementations must never become a
silent production fallback. This is the ONLY place that decides between
a real ModelClient and a Heuristic one, used identically by the Builder
router and the Runtime router.
"""
from __future__ import annotations

from app.common.config import Settings
from app.common.models.anthropic_client import AnthropicModelClient
from app.common.models.interface import ModelClient
from app.common.models.openai_client import OpenAIModelClient


class ModelClientConfigurationError(RuntimeError):
    """Raised at startup when running in production with no real LLM
    credentials configured. Never caught to silently substitute a dev/test
    Heuristic ModelClient — that substitution is only ever automatic in
    non-production modes."""


def select_model_client(settings: Settings, dev_fallback: ModelClient) -> ModelClient:
    # Anthropic takes priority when both keys happen to be configured —
    # arbitrary tie-break, kept stable so switching providers is always an
    # explicit "unset the other key" action, not order-of-evaluation luck.
    if settings.anthropic_api_key:
        return AnthropicModelClient(settings.anthropic_api_key, settings.model_provider_map)

    if settings.openai_api_key:
        return OpenAIModelClient(settings.openai_api_key, settings.openai_model_provider_map)

    if settings.mode == "production":
        raise ModelClientConfigurationError(
            "ANTHROPIC_API_KEY or OPENAI_API_KEY is required when BRAIN_ENV=production. "
            "Refusing to silently fall back to a dev/test Heuristic ModelClient in production."
        )

    return dev_fallback
