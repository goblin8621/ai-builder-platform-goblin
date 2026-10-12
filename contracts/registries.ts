/**
 * Model / Tool / Capability Registry contract (Phase 3).
 *
 * These are read-only listings the Brain serves (brain/app/registries/router.py)
 * and the BFF proxies (bff/src/registries/routes.ts). Skill CRUD's Registry
 * Validation (bff/src/skills/skill-registry-validator.ts) checks a Skill
 * Spec's modelId/tool refId/capabilities against exactly this data — never
 * a separately hand-maintained copy.
 */
import type { CapabilityFlags } from './skill-spec.js';

export type ModelDescriptor = {
  modelId: string;
  displayName: string;
  provider: string;
};

export type ToolDescriptor = {
  toolId: string;
  displayName: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /** Phase 9 (Skill Export): Provider-neutral description + reach protocol. */
  description?: string;
  protocol?: 'builtin' | 'mcp';
};

export type ModelsResponse = { models: ModelDescriptor[] };
export type ToolsResponse = { tools: ToolDescriptor[] };
export type CapabilitiesResponse = { capabilities: CapabilityFlags };

export type { CapabilityFlags };
