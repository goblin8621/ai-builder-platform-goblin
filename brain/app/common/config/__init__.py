"""Central config loader for the Brain service.

All environment access goes through here; no other module should read
os.environ directly (mirrors bff/src/config/index.ts).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    mode: str
    host: str
    port: int
    database_url: str

    # Model Client (Common Foundation) — 02번: Secret은 Skill Spec에 저장하지
    #않고, 실행 시 여기(Model Registry/Client 설정)에서만 resolve한다.
    anthropic_api_key: str | None
    # Maps OUR platform modelId (Model Registry, e.g. "model-001") to the
    # actual provider model string. Never stored in a Skill Spec.
    model_provider_map: dict[str, str] = field(default_factory=dict)
    # Second real provider (Phase 8 확장): same platform modelId space
    # ("model-001"/"model-002"), a different real provider model string per
    # provider — the Skill Spec/Registry ID never changes based on which
    # provider is actually configured (03번: Registry ID로만 참조).
    openai_api_key: str | None = None
    openai_model_provider_map: dict[str, str] = field(default_factory=dict)
    # Which platform modelId the Skill Builder itself uses to call the LLM.
    # This is independent of the modelId a generated Skill Spec chooses for
    # its OWN execution.
    builder_model_id: str = "model-001"
    # Fallback modelId an `llm` Step resolves to when its Skill Spec uses
    # model.mode="user" (no per-run override mechanism exists yet).
    default_run_model_id: str = "model-001"


def load_settings() -> Settings:
    return Settings(
        mode=os.environ.get("BRAIN_ENV", "development"),
        host=os.environ.get("BRAIN_HOST", "0.0.0.0"),
        port=int(os.environ.get("BRAIN_PORT", "8000")),
        database_url=os.environ.get(
            "DATABASE_URL",
            "postgresql://ai_builder:ai_builder@localhost:5477/ai_builder_platform",
        ),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY") or None,
        model_provider_map={
            "model-001": os.environ.get("MODEL_001_PROVIDER_ID", "claude-sonnet-4-5-20250929"),
            "model-002": os.environ.get("MODEL_002_PROVIDER_ID", "claude-sonnet-4-5-20250929"),
        },
        openai_api_key=os.environ.get("OPENAI_API_KEY") or None,
        openai_model_provider_map={
            "model-001": os.environ.get("MODEL_001_OPENAI_MODEL_ID", "gpt-4o-mini"),
            "model-002": os.environ.get("MODEL_002_OPENAI_MODEL_ID", "gpt-4o-mini"),
        },
        builder_model_id=os.environ.get("BUILDER_MODEL_ID", "model-001"),
        default_run_model_id=os.environ.get("DEFAULT_RUN_MODEL_ID", "model-001"),
    )


settings = load_settings()
