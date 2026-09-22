"""RequestContext mirrors contracts/common-types.ts RequestContext.

Brain does not resolve identity itself (no AuthContextProvider here) —
BFF is the only place identity is decided. Brain only accepts the
context that BFF already resolved, propagated via request headers,
and must treat it as a required, explicit parameter everywhere
(never a global/hardcoded value).
"""
from __future__ import annotations

from typing import Optional

from fastapi import Header
from pydantic import BaseModel


class RequestContext(BaseModel):
    userId: str
    workspaceId: str
    requestId: str
    conversationId: Optional[str] = None


def get_request_context(
    x_user_id: str = Header(..., alias="x-user-id"),
    x_workspace_id: str = Header(..., alias="x-workspace-id"),
    x_request_id: str = Header(..., alias="x-request-id"),
    x_conversation_id: Optional[str] = Header(None, alias="x-conversation-id"),
) -> RequestContext:
    """FastAPI dependency: extracts RequestContext from propagated headers.

    Missing required headers fail the request with FastAPI's standard
    422 validation error — Brain will not silently default identity.
    """
    return RequestContext(
        userId=x_user_id,
        workspaceId=x_workspace_id,
        requestId=x_request_id,
        conversationId=x_conversation_id,
    )
