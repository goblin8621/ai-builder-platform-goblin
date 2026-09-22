from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_ok():
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body == {"status": "ok", "service": "brain"}


def test_health_does_not_require_request_context_headers():
    # Infra health checks may not send x-user-id/x-workspace-id/x-request-id;
    # /health must stay reachable without them.
    response = client.get("/health")
    assert response.status_code == 200
