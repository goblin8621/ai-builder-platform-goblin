from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.common.context.request_context import RequestContext, get_request_context

app = FastAPI()


@app.get("/whoami")
def whoami(context: RequestContext = Depends(get_request_context)):
    return context.model_dump()


client = TestClient(app)


def test_resolves_context_from_headers():
    response = client.get(
        "/whoami",
        headers={
            "x-user-id": "user-1",
            "x-workspace-id": "workspace-1",
            "x-request-id": "req-1",
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "userId": "user-1",
        "workspaceId": "workspace-1",
        "requestId": "req-1",
        "conversationId": None,
    }


def test_missing_required_header_is_rejected():
    response = client.get("/whoami", headers={"x-user-id": "user-1"})
    assert response.status_code == 422
