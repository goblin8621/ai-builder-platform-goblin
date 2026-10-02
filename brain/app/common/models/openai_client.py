"""Real ModelClient implementation backed by the OpenAI API (Phase 8 확장).

Second real provider alongside `anthropic_client.py` — same `ModelClient`
interface, same rule: the key never appears in a Skill Spec, only here
(02번: "Secret은 Skill Spec에 저장하지 않는다").

The `openai` package is imported lazily inside `complete()`, mirroring
`anthropic_client.py`, so importing this module never fails just because
the package isn't installed or no key is configured.
"""
from __future__ import annotations

from app.common.errors import AppError
from app.common.models.interface import ModelClient, ModelCompletionRequest, ModelCompletionResult


class OpenAIModelClient(ModelClient):
    def __init__(self, api_key: str | None, provider_model_map: dict[str, str]) -> None:
        self._api_key = api_key
        self._provider_model_map = provider_model_map

    async def complete(self, request: ModelCompletionRequest) -> ModelCompletionResult:
        if not self._api_key:
            raise AppError(
                "upstream_unavailable",
                "OPENAI_API_KEY is not configured — cannot call the real Model Client",
            )

        provider_model = self._provider_model_map.get(request.model_id)
        if not provider_model:
            raise AppError(
                "validation_error",
                f'No provider model mapping configured for modelId "{request.model_id}"',
            )

        from openai import AsyncOpenAI  # local import: optional dependency at runtime only

        client = AsyncOpenAI(api_key=self._api_key)
        # Unlike Anthropic (which needs `system` split out of `messages`),
        # OpenAI's Chat Completions API accepts a "system" role entry
        # directly inside `messages` — the exact shape execution_engine.py /
        # builder_service.py already build, no translation needed here.
        response = await client.chat.completions.create(
            model=provider_model,
            max_tokens=request.max_tokens or 4096,
            temperature=request.temperature if request.temperature is not None else 0.0,
            messages=request.messages,
        )
        text = response.choices[0].message.content or ""
        return ModelCompletionResult(text=text, raw=response.model_dump())
