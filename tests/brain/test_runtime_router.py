from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

HEADERS = {"x-user-id": "user-1", "x-workspace-id": "workspace-1", "x-request-id": "req-1"}

PROMPT_SPEC = {
    "schemaVersion": "1.0",
    "name": "Translator",
    "description": "translate",
    "skillType": "prompt",
    "inputSchema": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}},
    "outputSchema": {
        "type": "object",
        "required": ["translatedText"],
        "properties": {"translatedText": {"type": "string"}},
    },
    "instructions": {"objective": "translate", "rules": []},
    "model": {"mode": "user", "modelId": None, "allowUserOverride": True},
    "capabilities": {
        "webSearch": False,
        "imageGeneration": False,
        "codeExecution": False,
        "dataAnalysis": False,
        "fileAnalysis": False,
        "knowledgeSearch": False,
        "mcp": False,
    },
    "knowledge": {"mode": "none", "documentIds": []},
    "execution": {"steps": [{"id": "translate", "name": "Translate", "type": "llm"}]},
    "runtime": {"timeoutSec": 30, "retryCount": 1, "maxToolCalls": 0, "maxNestedSkillDepth": 0},
    "guardrails": [],
    "usageExamples": [],
    "metadata": {"category": "translation", "tags": []},
}


def test_execute_returns_completed_run_result():
    response = client.post(
        "/runtime/execute",
        json={"spec": PROMPT_SPEC, "input": {"text": "안녕하세요"}},
        headers=HEADERS,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert "translatedText" in body["output"]
    assert body["steps"][0]["stepId"] == "translate"


def test_execute_requires_context_headers():
    response = client.post("/runtime/execute", json={"spec": PROMPT_SPEC, "input": {"text": "hi"}})
    assert response.status_code == 422
