"""Common error types mirroring contracts/common-types.ts ApiError.

Keep ApiErrorCode values identical to the TypeScript union so BFF and
Brain error codes never drift apart.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel

ApiErrorCode = Literal[
    "validation_error",
    "not_found",
    "version_conflict",
    "unauthorized",
    "forbidden",
    "upstream_timeout",
    "upstream_unavailable",
    "internal_error",
]

_STATUS_BY_CODE: dict[str, int] = {
    "validation_error": 400,
    "not_found": 404,
    "version_conflict": 409,
    "unauthorized": 401,
    "forbidden": 403,
    "upstream_timeout": 504,
    "upstream_unavailable": 502,
    "internal_error": 500,
}


class ApiError(BaseModel):
    code: ApiErrorCode
    message: str
    details: Optional[dict[str, Any]] = None
    requestId: Optional[str] = None


class ApiErrorResponse(BaseModel):
    error: ApiError


class AppError(Exception):
    def __init__(
        self,
        code: ApiErrorCode,
        message: str,
        details: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    @property
    def http_status(self) -> int:
        return _STATUS_BY_CODE[self.code]

    def to_api_error(self, request_id: Optional[str] = None) -> ApiError:
        return ApiError(
            code=self.code,
            message=self.message,
            details=self.details,
            requestId=request_id,
        )
