import json

import pytest

from app.common.models.heuristic_runtime_client import HeuristicRuntimeModelClient
from app.common.models.interface import ModelCompletionRequest
from app.skills.step_prompts import build_step_system_prompt, build_step_user_prompt


@pytest.mark.asyncio
async def test_produces_output_matching_every_required_property_type():
    output_schema = {
        "type": "object",
        "required": ["text", "count", "ok", "items", "meta"],
        "properties": {
            "text": {"type": "string"},
            "count": {"type": "number"},
            "ok": {"type": "boolean"},
            "items": {"type": "array"},
            "meta": {"type": "object"},
        },
    }
    messages = [
        {"role": "system", "content": build_step_system_prompt("obj", [])},
        {"role": "user", "content": build_step_user_prompt({"text": "hello"}, output_schema)},
    ]

    client = HeuristicRuntimeModelClient()
    result = await client.complete(ModelCompletionRequest(model_id="model-001", messages=messages))
    output = json.loads(result.text)

    assert isinstance(output["text"], str) and "hello" in output["text"]
    assert output["count"] == 0
    assert output["ok"] is False
    assert output["items"] == []
    assert output["meta"] == {}


@pytest.mark.asyncio
async def test_raises_when_no_marker_present():
    client = HeuristicRuntimeModelClient()
    with pytest.raises(ValueError):
        await client.complete(ModelCompletionRequest(model_id="model-001", messages=[{"role": "user", "content": "no marker here"}]))
