-- Phase 1: Project Bootstrap / Common Foundation
-- Creates only the `workspaces` table (02번 데이터 모델 설계 기준).
-- skills / skill_versions / skill_runs / skill_run_steps / documents /
-- document_chunks are created in Phase 2 (Skill Contract / DB), per the
-- documented Phase order (09/06번) — not created here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workspaces (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
