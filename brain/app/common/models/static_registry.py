"""Static, hardcoded ModelRegistry implementation.

Phase 3 scope: gives Builder/CRUD Registry Validation something real to
check `modelId` against. No actual model execution is wired yet — that
is ModelClient's job, still unimplemented (Phase 5+).
"""
from __future__ import annotations

from app.common.models.interface import ModelDescriptor, ModelRegistry

_CATALOG: list[ModelDescriptor] = [
    ModelDescriptor(model_id="model-001", display_name="General Purpose Model", provider="internal"),
    ModelDescriptor(model_id="model-002", display_name="Data Analysis Model", provider="internal"),
]


class StaticModelRegistry(ModelRegistry):
    def list_available(self) -> list[ModelDescriptor]:
        return list(_CATALOG)

    def exists(self, model_id: str) -> bool:
        return any(m.model_id == model_id for m in _CATALOG)
