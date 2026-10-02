/**
 * Central config loader. All environment access goes through here —
 * no other module should read process.env directly.
 */

export type AppMode = 'development' | 'test' | 'production';

export type AppConfig = {
  mode: AppMode;
  port: number;
  database: {
    url: string;
  };
  brain: {
    baseUrl: string;
    timeoutMs: number;
  };
  auth: {
    /** Seed identity used by DevAuthContextProvider. Never used outside development/test. */
    devSeedUserId: string;
    devSeedWorkspaceId: string;
    /** Allow per-request override of identity via headers. Dev/test only. */
    devAllowContextOverrideHeaders: boolean;
  };
  /** Origins allowed to call the BFF from a browser (Phase 7: web/). */
  webOrigins: string[];
};

function readMode(): AppMode {
  const raw = process.env.NODE_ENV ?? 'development';
  if (raw === 'production' || raw === 'test' || raw === 'development') {
    return raw;
  }
  return 'development';
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(): AppConfig {
  const mode = readMode();

  return {
    mode,
    port: readInt('BFF_PORT', 4000),
    database: {
      url:
        process.env.DATABASE_URL ??
        'postgresql://ai_builder:ai_builder@localhost:5477/ai_builder_platform',
    },
    brain: {
      baseUrl: process.env.BRAIN_BASE_URL ?? 'http://localhost:8000',
      timeoutMs: readInt('BRAIN_TIMEOUT_MS', 10_000),
    },
    auth: {
      devSeedUserId:
        process.env.DEV_SEED_USER_ID ?? '00000000-0000-0000-0000-000000000001',
      devSeedWorkspaceId:
        process.env.DEV_SEED_WORKSPACE_ID ?? '00000000-0000-0000-0000-0000000000a1',
      devAllowContextOverrideHeaders: mode !== 'production',
    },
    webOrigins: (process.env.WEB_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
  };
}
