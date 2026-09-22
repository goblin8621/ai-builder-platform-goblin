-- Phase 2: Skill Contract / DB
-- Creates the core Skill Registry / Run tables (02번 데이터 모델 설계 기준).
--
-- Notes:
-- * owner_id / created_by are opaque uuid identity references (no `users`
--   table exists per 02번 스키마 — Standalone Auth Phase 1 결정: 실제 로그인
--   시스템 없이 RequestContext.userId만 사용).
-- * document_chunks.embedding is stored as jsonb for now (a plain float
--   array), not a pgvector `vector` column — pgvector is not part of the
--   base postgres:16-alpine image used by docker-compose.yml. Revisit when
--   Knowledge/RAG is actually implemented (Phase 6).

CREATE TABLE IF NOT EXISTS skills (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspaces(id),
    owner_id        uuid NOT NULL,
    name            text NOT NULL,
    description     text NOT NULL,
    skill_type      text NOT NULL
                        CHECK (skill_type IN ('prompt','knowledge','tool','workflow','composite')),
    status          text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','archived')),
    visibility      text NOT NULL DEFAULT 'private'
                        CHECK (visibility = 'private'),
    current_version integer NOT NULL DEFAULT 1,
    deleted_at      timestamptz NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id        uuid NOT NULL REFERENCES skills(id),
    version         integer NOT NULL,
    spec_json       jsonb NOT NULL,
    change_source   text NOT NULL
                        CHECK (change_source IN ('create','ai_refine','manual','restore','migration')),
    change_summary  text NULL,
    created_by      uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    UNIQUE (skill_id, version)
);

CREATE TABLE IF NOT EXISTS skill_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        uuid NOT NULL REFERENCES workspaces(id),
    skill_id            uuid NOT NULL REFERENCES skills(id),
    skill_version_id    uuid NOT NULL REFERENCES skill_versions(id),
    parent_run_id       uuid NULL REFERENCES skill_runs(id),
    request_id          text NULL,
    mode                text NOT NULL CHECK (mode IN ('run','preview')),
    status              text NOT NULL
                            CHECK (status IN ('queued','running','waiting_approval','completed','failed','cancelled')),
    input_json          jsonb NOT NULL,
    output_json         jsonb NULL,
    error_json          jsonb NULL,
    started_at          timestamptz NULL,
    completed_at        timestamptz NULL,
    created_by          uuid NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_run_steps (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          uuid NOT NULL REFERENCES skill_runs(id),
    step_id         text NOT NULL,
    step_type       text NOT NULL,
    status          text NOT NULL
                        CHECK (status IN ('pending','running','waiting_approval','completed','failed','skipped')),
    attempt         integer NOT NULL,
    input_json      jsonb NULL,
    output_json     jsonb NULL,
    error_json      jsonb NULL,
    started_at      timestamptz NULL,
    completed_at    timestamptz NULL
);

CREATE TABLE IF NOT EXISTS documents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspaces(id),
    file_name       text NOT NULL,
    mime_type       text NOT NULL,
    storage_key     text NOT NULL,
    status          text NOT NULL
                        CHECK (status IN ('uploaded','processing','ready','failed')),
    created_by      uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_chunks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     uuid NOT NULL REFERENCES documents(id),
    chunk_index     integer NOT NULL,
    content         text NOT NULL,
    embedding       jsonb NULL
);

-- 02번 문서 7. 필수 인덱스
CREATE INDEX IF NOT EXISTS idx_skills_workspace_owner_status
    ON skills (workspace_id, owner_id, status);

CREATE INDEX IF NOT EXISTS idx_skill_runs_workspace_skill_created_at
    ON skill_runs (workspace_id, skill_id, created_at);

CREATE INDEX IF NOT EXISTS idx_skill_runs_parent_run_id
    ON skill_runs (parent_run_id);

CREATE INDEX IF NOT EXISTS idx_skill_runs_request_id
    ON skill_runs (request_id);

CREATE INDEX IF NOT EXISTS idx_skill_run_steps_run_step_attempt
    ON skill_run_steps (run_id, step_id, attempt);

CREATE INDEX IF NOT EXISTS idx_documents_workspace_status
    ON documents (workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_document_chunks_document_chunk_index
    ON document_chunks (document_id, chunk_index);
