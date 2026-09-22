import pytest

from app.common.errors import AppError
from app.common.models.anthropic_client import AnthropicModelClient
from app.common.models.interface import ModelCompletionRequest


@pytest.mark.asyncio
async def test_raises_without_api_key_and_never_touches_the_network():
    client = AnthropicModelClient(api_key=None, provider_model_map={"model-001": "claude-sonnet-4-5-20250929"})

    with pytest.raises(AppError) as exc_info:
        await client.complete(ModelCompletionRequest(model_id="model-001", messages=[]))

    assert exc_info.value.code == "upstream_unavailable"


@pytest.mark.asyncio
async def test_raises_validation_error_for_unmapped_model_id():
    client = AnthropicModelClient(api_key="fake-key-not-used", provider_model_map={"model-001": "claude-sonnet-4-5-20250929"})

    with pytest.raises(AppError) as exc_info:
        await client.complete(ModelCompletionRequest(model_id="model-999", messages=[]))

    assert exc_info.value.code == "validation_error"
