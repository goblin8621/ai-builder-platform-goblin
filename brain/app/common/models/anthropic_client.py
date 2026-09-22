"""Real ModelClient implementation backed by the Anthropic API.

This is the PRODUCTION path. It requires `ANTHROPIC_API_KEY` to be set
(brain/app/common/config) — the key never appears in a Skill Spec, only
here, consistent with 02번: "Secret은 Skill Spec에 저장하지 않는다".

The `anthropic` package is imported lazily inside `complete()` so that
importing this module (or the rest of the app) never fails just because
the package isn't installed or no key is configured — the error only
surfaces when the client is actually invoked without a key.
"""
from __future__ import annotations

from app.common.errors import AppError
from app.common.models.interface import ModelClient, ModelCompletionRequest, ModelCompletionResult


class AnthropicModelClient(ModelClient):
    def __init__(self, api_key: str | None, provider_model_map: dict[str, str]) -> None:
        self._api_key = api_key
        self._provider_model_map = provider_model_map

    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResult:
        if not self._api_key:
            raise AppError(
                "upstream_unavailable",
                "ANTHROPIC_API_KEY is not configured — cannot call the real Model Client",
            )

        provider_model = self._provider_model_map.get(request.model_id)
        if not provider_model:
            raise AppError(
                "validation_error",
                f'No provider model mapping configured for modelId "{request.model_id}"',
            )

        from anthropic import AsyncAnthropic  # local import: optional dependency at runtime only

        client = AsyncAnthropic(api_key=self._api_key)
        response = await client.messages.create(
            model=provider_model,
            max_tokens=request.max_tokens or 4096,
            temperature=request.temperature if request.temperature is not None else 0.0,
            messages=request.messages,
        )
        text = "".join(block.text for block in response.content if getattr(block, "type", None) == "text")
        return ModelCompletionResult(text=text, raw=response.model_dump())
