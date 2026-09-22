from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_list_models_returns_static_catalog():
    response = client.get("/models")
    assert response.status_code == 200
    body = response.json()
    ids = [m["modelId"] for m in body["models"]]
    assert "model-001" in ids
    assert "model-002" in ids


def test_list_tools_returns_static_catalog():
    response = client.get("/tools")
    assert response.status_code == 200
    body = response.json()
    ids = [t["toolId"] for t in body["tools"]]
    assert "file-parser" in ids
    assert "python-data-analysis" in ids
    assert "service-status" in ids


def test_capabilities_reflect_phase6_implementations():
    response = client.get("/capabilities")
    assert response.status_code == 200
    flags = response.json()["capabilities"]
    assert flags["codeExecution"] is True
    assert flags["dataAnalysis"] is True
    assert flags["fileAnalysis"] is True
    assert flags["knowledgeSearch"] is True
    # Still genuinely unimplemented (no external service integration):
    assert flags["webSearch"] is False
    assert flags["imageGeneration"] is False
    assert flags["mcp"] is False
