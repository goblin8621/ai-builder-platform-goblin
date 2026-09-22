/**
 * Skill Builder contract (04번 문서) — internal BFF <-> Brain request/response
 * shape for `POST /builder/build` and `POST /builder/refine` (Brain-side)
 * and the public `POST /skills/build` / `POST /skills/:id/refine` (BFF-side).
 */
import type { SkillSpecV1 } from './skill-spec.js';

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
};

export type DocumentSummary = {
  id: string;
  fileName: string;
};

export type BuilderRequestBody = {
  request: string;
  currentSpec?: SkillSpecV1 | null;
  availableSkills: SkillSummary[];
  availableKnowledge: DocumentSummary[];
  defaults?: Record<string, unknown>;
};

export type BuilderAction = 'draft' | 'update' | 'clarify';

export type BuilderOutput = {
  action: BuilderAction;
  message?: string | null;
  changeSummary?: string[] | null;
  missingFields?: string[] | null;
  spec?: SkillSpecV1 | null;
};
