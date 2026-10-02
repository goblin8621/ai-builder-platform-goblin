import type {
  ModelDescriptor,
  SkillRecord,
  SkillRunRecord,
  SkillRunStepRecord,
  SkillSpecV1,
  SkillVersionRecord,
  ToolDescriptor,
} from './types';

const BFF_URL = process.env.NEXT_PUBLIC_BFF_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only set content-type when there IS a body — Fastify's JSON body
  // parser rejects an empty body declared as application/json (e.g. the
  // bodyless POST /skills/:id/activate) with a 500.
  const headers = init?.body ? { 'content-type': 'application/json', ...(init?.headers ?? {}) } : init?.headers;
  const response = await fetch(`${BFF_URL}${path}`, { ...init, headers });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (body?.error?.code) {
      throw new ApiError(body.error.code, body.error.message ?? 'Request failed', body.error.details);
    }
    throw new ApiError('internal_error', `Request to ${path} failed with status ${response.status}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ---------- Skills ----------

export function listSkills() {
  return request<{ skills: SkillRecord[] }>('/skills');
}

export function getSkill(id: string) {
  return request<{ skill: SkillRecord; version: SkillVersionRecord }>(`/skills/${id}`);
}

export function createSkill(spec: SkillSpecV1) {
  return request<{ skill: SkillRecord; version: SkillVersionRecord }>('/skills', {
    method: 'POST',
    body: JSON.stringify({ spec }),
  });
}

export function updateSkill(id: string, expectedVersion: number, spec: SkillSpecV1) {
  return request<{ skill: SkillRecord; version: SkillVersionRecord }>(`/skills/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ expectedVersion, spec }),
  });
}

export function buildSkill(userRequest: string) {
  return request<
    | { action: 'draft'; skill: SkillRecord; version: SkillVersionRecord }
    | { action: 'clarify'; message: string | null; missingFields: string[] | null }
  >('/skills/build', { method: 'POST', body: JSON.stringify({ request: userRequest }) });
}

export function refineSkill(id: string, expectedVersion: number, userRequest: string) {
  return request<
    | { action: 'update'; skill: SkillRecord; version: SkillVersionRecord }
    | { action: 'clarify'; message: string | null; missingFields: string[] | null }
  >(`/skills/${id}/refine`, { method: 'POST', body: JSON.stringify({ expectedVersion, request: userRequest }) });
}

export function activateSkill(id: string) {
  return request<{ skill: SkillRecord }>(`/skills/${id}/activate`, { method: 'POST' });
}

export function duplicateSkill(id: string) {
  return request<{ skill: SkillRecord; version: SkillVersionRecord }>(`/skills/${id}/duplicate`, { method: 'POST' });
}

export function deleteSkill(id: string) {
  return request<void>(`/skills/${id}`, { method: 'DELETE' });
}

export function listSkillVersions(id: string) {
  return request<{ versions: SkillVersionRecord[] }>(`/skills/${id}/versions`);
}

export function restoreSkillVersion(id: string, version: number) {
  return request<{ skill: SkillRecord; version: SkillVersionRecord }>(`/skills/${id}/versions/${version}/restore`, {
    method: 'POST',
  });
}

// ---------- Registries ----------

export function listModels() {
  return request<{ models: ModelDescriptor[] }>('/models');
}

export function listTools() {
  return request<{ tools: ToolDescriptor[] }>('/tools');
}

export function getCapabilities() {
  return request<{ capabilities: Record<string, boolean> }>('/capabilities');
}

// ---------- Skill Runs ----------

export type RunResponse = {
  run: SkillRunRecord;
  steps: SkillRunStepRecord[];
  childRuns?: SkillRunRecord[];
  pendingApproval?: { stepId: string; stepType: string; input: Record<string, unknown> } | null;
};

export function createRun(skillId: string, input: Record<string, unknown>, mode: 'run' | 'preview' = 'preview') {
  return request<RunResponse>('/skill-runs', { method: 'POST', body: JSON.stringify({ skillId, input, mode }) });
}

export function getRun(runId: string) {
  return request<RunResponse>(`/skill-runs/${runId}`);
}

export function approveRun(runId: string) {
  return request<RunResponse>(`/skill-runs/${runId}/approve`, { method: 'POST' });
}

export function rejectRun(runId: string) {
  return request<RunResponse>(`/skill-runs/${runId}/reject`, { method: 'POST' });
}

export function cancelRun(runId: string) {
  return request<RunResponse>(`/skill-runs/${runId}/cancel`, { method: 'POST' });
}

// ---------- Documents ----------

export function listDocuments() {
  return request<{ documents: { id: string; fileName: string; status: string; createdAt: string }[] }>('/documents');
}

export function createDocument(fileName: string, content: string) {
  return request<{ document: unknown }>('/documents', { method: 'POST', body: JSON.stringify({ fileName, content }) });
}

export function deleteDocument(id: string) {
  return request<void>(`/documents/${id}`, { method: 'DELETE' });
}
