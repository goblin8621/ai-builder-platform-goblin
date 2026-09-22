import type { Pool, PoolClient } from 'pg';
import type { SkillSpecV1 } from '../../../contracts/skill-spec.js';

export type SkillStatus = 'draft' | 'active' | 'archived';
export type ChangeSource = 'create' | 'ai_refine' | 'manual' | 'restore' | 'migration';

export type SkillRecord = {
  id: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  description: string;
  skillType: string;
  status: SkillStatus;
  visibility: 'private';
  currentVersion: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillVersionRecord = {
  id: string;
  skillId: string;
  version: number;
  spec: SkillSpecV1;
  changeSource: ChangeSource;
  changeSummary: string | null;
  createdBy: string;
  createdAt: string;
};

function toSkillRecord(row: any): SkillRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    skillType: row.skill_type,
    status: row.status,
    visibility: row.visibility,
    currentVersion: row.current_version,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSkillVersionRecord(row: any): SkillVersionRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    spec: row.spec_json,
    changeSource: row.change_source,
    changeSummary: row.change_summary,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function listSkills(pool: Pool, workspaceId: string): Promise<SkillRecord[]> {
  const result = await pool.query(
    `SELECT * FROM skills WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map(toSkillRecord);
}

export async function getSkill(pool: Pool, workspaceId: string, skillId: string): Promise<SkillRecord | null> {
  const result = await pool.query(
    `SELECT * FROM skills WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [skillId, workspaceId],
  );
  return result.rows[0] ? toSkillRecord(result.rows[0]) : null;
}

export async function getSkillVersion(
  pool: Pool | PoolClient,
  skillId: string,
  version: number,
): Promise<SkillVersionRecord | null> {
  const result = await pool.query(
    `SELECT * FROM skill_versions WHERE skill_id = $1 AND version = $2`,
    [skillId, version],
  );
  return result.rows[0] ? toSkillVersionRecord(result.rows[0]) : null;
}

/** Looks up a Version by its own row id — used to reload the EXACT pinned
 * spec of an existing Run (which may no longer be the skill's current
 * version), e.g. when resuming a `waiting_approval` Run. */
export async function getSkillVersionById(
  pool: Pool | PoolClient,
  skillVersionId: string,
): Promise<SkillVersionRecord | null> {
  const result = await pool.query(`SELECT * FROM skill_versions WHERE id = $1`, [skillVersionId]);
  return result.rows[0] ? toSkillVersionRecord(result.rows[0]) : null;
}

export async function listSkillVersions(pool: Pool, skillId: string): Promise<SkillVersionRecord[]> {
  const result = await pool.query(
    `SELECT * FROM skill_versions WHERE skill_id = $1 ORDER BY version DESC`,
    [skillId],
  );
  return result.rows.map(toSkillVersionRecord);
}

/**
 * Fetches the CURRENT version's spec for a skill in the given workspace.
 * Returns null if the skill does not exist, is soft-deleted, or belongs to
 * a different workspace (Workspace Isolation — 02번 문서).
 */
export async function getCurrentSpec(
  pool: Pool | PoolClient,
  workspaceId: string,
  skillId: string,
): Promise<SkillSpecV1 | null> {
  const result = await pool.query(
    `SELECT sv.spec_json
       FROM skills s
       JOIN skill_versions sv ON sv.skill_id = s.id AND sv.version = s.current_version
      WHERE s.id = $1 AND s.workspace_id = $2 AND s.deleted_at IS NULL`,
    [skillId, workspaceId],
  );
  return result.rows[0] ? (result.rows[0].spec_json as SkillSpecV1) : null;
}

export type SkillSummary = { id: string; name: string; description: string };
export type DocumentSummary = { id: string; fileName: string };

/** Used only to feed the Skill Builder's `availableSkills` context (04번 입력). */
export async function listSkillSummaries(pool: Pool, workspaceId: string): Promise<SkillSummary[]> {
  const result = await pool.query(
    `SELECT id, name, description FROM skills WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map((r) => ({ id: r.id, name: r.name, description: r.description }));
}

/**
 * Used only to feed the Skill Builder's `availableKnowledge` context.
 * Not a public Document API (that is Phase 6) — an internal read of a
 * table that already exists (Phase 2), which will always be empty until
 * Phase 6 adds document upload.
 */
export async function listDocumentSummaries(pool: Pool, workspaceId: string): Promise<DocumentSummary[]> {
  const result = await pool.query(
    `SELECT id, file_name FROM documents WHERE workspace_id = $1 AND status = 'ready' ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map((r) => ({ id: r.id, fileName: r.file_name }));
}

export async function skillExists(pool: Pool | PoolClient, workspaceId: string, skillId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM skills WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [skillId, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function documentIdsExist(
  pool: Pool | PoolClient,
  workspaceId: string,
  documentIds: string[],
): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const result = await pool.query(
    `SELECT id FROM documents WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [workspaceId, documentIds],
  );
  return new Set(result.rows.map((r) => r.id as string));
}

export type CreateSkillInput = {
  workspaceId: string;
  ownerId: string;
  spec: SkillSpecV1;
};

export async function createSkill(pool: Pool, input: CreateSkillInput): Promise<{ skill: SkillRecord; version: SkillVersionRecord }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const skillResult = await client.query(
      `INSERT INTO skills (workspace_id, owner_id, name, description, skill_type, status, current_version)
       VALUES ($1, $2, $3, $4, $5, 'draft', 1)
       RETURNING *`,
      [input.workspaceId, input.ownerId, input.spec.name, input.spec.description, input.spec.skillType],
    );
    const skill = toSkillRecord(skillResult.rows[0]);

    const versionResult = await client.query(
      `INSERT INTO skill_versions (skill_id, version, spec_json, change_source, created_by)
       VALUES ($1, 1, $2, 'create', $3)
       RETURNING *`,
      [skill.id, JSON.stringify(input.spec), input.ownerId],
    );
    const version = toSkillVersionRecord(versionResult.rows[0]);

    await client.query('COMMIT');
    return { skill, version };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type AppendVersionInput = {
  skillId: string;
  spec: SkillSpecV1;
  changeSource: ChangeSource;
  changeSummary?: string | null;
  createdBy: string;
};

/**
 * Appends a new Skill Version and advances `current_version` atomically.
 * Never updates an existing skill_versions row (02번: append-only).
 */
export async function appendSkillVersion(
  pool: Pool,
  input: AppendVersionInput,
): Promise<{ skill: SkillRecord; version: SkillVersionRecord }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const currentResult = await client.query(`SELECT * FROM skills WHERE id = $1 FOR UPDATE`, [input.skillId]);
    const currentSkill = toSkillRecord(currentResult.rows[0]);
    const nextVersion = currentSkill.currentVersion + 1;

    const versionResult = await client.query(
      `INSERT INTO skill_versions (skill_id, version, spec_json, change_source, change_summary, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.skillId,
        nextVersion,
        JSON.stringify(input.spec),
        input.changeSource,
        input.changeSummary ?? null,
        input.createdBy,
      ],
    );
    const version = toSkillVersionRecord(versionResult.rows[0]);

    const skillResult = await client.query(
      `UPDATE skills
          SET current_version = $1, name = $2, description = $3, updated_at = now()
        WHERE id = $4
        RETURNING *`,
      [nextVersion, input.spec.name, input.spec.description, input.skillId],
    );
    const skill = toSkillRecord(skillResult.rows[0]);

    await client.query('COMMIT');
    return { skill, version };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function activateSkill(pool: Pool, workspaceId: string, skillId: string): Promise<SkillRecord | null> {
  const result = await pool.query(
    `UPDATE skills SET status = 'active', updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
      RETURNING *`,
    [skillId, workspaceId],
  );
  return result.rows[0] ? toSkillRecord(result.rows[0]) : null;
}

export async function softDeleteSkill(pool: Pool, workspaceId: string, skillId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE skills SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [skillId, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Returns the `refId`s of every `skill`-type step in the CURRENT version of
 * the given (existing, non-deleted, same-workspace) skill. Used by Registry
 * Validation to walk the child-Skill reference graph for cycle detection.
 */
export async function getChildSkillIds(
  pool: Pool | PoolClient,
  workspaceId: string,
  skillId: string,
): Promise<string[]> {
  const spec = await getCurrentSpec(pool, workspaceId, skillId);
  if (!spec) return [];
  return spec.execution.steps.filter((s) => s.type === 'skill' && s.refId).map((s) => s.refId as string);
}

export type ResolvedChildSkill = { skillId: string; skillVersionId: string; spec: SkillSpecV1 };

/**
 * Nested Skill (08번 8.): resolves every `skill`-type step reachable from
 * `rootSpec`, up to `maxDepth` levels, PINNING each child's CURRENT
 * Version at this moment (08번: "Child Version을 호출 시점에 고정") —
 * exactly like the top-level Run pins its own Skill Version.
 *
 * A child id that does not resolve (deleted, wrong workspace, or beyond
 * maxDepth) is simply left OUT of the returned map — Brain's Execution
 * Engine treats a missing map entry as a clear "not provided" failure,
 * which doubles as maxNestedSkillDepth/cycle enforcement without Brain
 * needing to count anything itself. Cycles were already blocked at save
 * time (Phase 3 skill-registry-validator), so this traversal cannot loop
 * forever even without an explicit visited-guard, but one is kept anyway
 * as defense in depth.
 */
export async function resolveChildSkillsRecursive(
  pool: Pool,
  workspaceId: string,
  rootSpec: SkillSpecV1,
  maxDepth: number,
): Promise<Record<string, ResolvedChildSkill>> {
  const resolved: Record<string, ResolvedChildSkill> = {};
  let frontier: SkillSpecV1[] = [rootSpec];
  let depth = 0;

  while (frontier.length > 0 && depth < maxDepth) {
    const nextFrontier: SkillSpecV1[] = [];
    for (const spec of frontier) {
      const childIds = spec.execution.steps.filter((s) => s.type === 'skill' && s.refId).map((s) => s.refId as string);
      for (const childId of childIds) {
        if (resolved[childId]) continue; // already resolved (shared child reused across branches)
        const skill = await getSkill(pool, workspaceId, childId);
        if (!skill) continue;
        const version = await getSkillVersion(pool, childId, skill.currentVersion);
        if (!version) continue;
        resolved[childId] = { skillId: childId, skillVersionId: version.id, spec: version.spec };
        nextFrontier.push(version.spec);
      }
    }
    frontier = nextFrontier;
    depth += 1;
  }

  return resolved;
}
