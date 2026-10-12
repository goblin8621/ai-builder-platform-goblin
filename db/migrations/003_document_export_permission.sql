-- Phase 9: Skill Export / Portability — Document Export permission.
--
-- Fail-closed: every document (existing and new) is NOT exportable until a
-- workspace admin explicitly allows it (PATCH /documents/:id {exportAllowed}).
-- Including a document in an Export Package requires ALL of:
--   workspace permission  AND  document access permission  AND  export_allowed = true
-- ("Workspace 소속 + ready 상태"만으로는 Export를 허용하지 않는다.)

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS export_allowed boolean NOT NULL DEFAULT false;
