from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.common.errors import AppError
from app.common.logging import error as log_error
from app.registries.router import router as registries_router
from app.skills.router import router as builder_router
from app.skills.runtime_router import router as runtime_router

app = FastAPI(title="AI Builder Platform - Brain", version="0.1.0")
app.include_router(registries_router)
app.include_router(builder_router)
app.include_router(runtime_router)


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    request_id = request.headers.get("x-request-id")
    log_error(exc.message, code=exc.code, requestId=request_id)
    return JSONResponse(
        status_code=exc.http_status,
        content={"error": exc.to_api_error(request_id).model_dump()},
    )


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness/readiness check. Intentionally does not require
    RequestContext headers — infra health checks may not send them.
    """
    return {"status": "ok", "service": "brain"}
