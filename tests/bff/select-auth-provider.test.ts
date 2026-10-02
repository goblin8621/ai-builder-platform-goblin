import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../bff/src/config/index.js';
import { DevAuthContextProvider } from '../../bff/src/client-context/DevAuthContextProvider.js';
import { AuthProviderConfigurationError, selectAuthProvider } from '../../bff/src/client-context/select-auth-provider.js';

function makeConfig(mode: AppConfig['mode']): AppConfig {
  return {
    mode,
    port: 4000,
    database: { url: 'postgresql://x' },
    brain: { baseUrl: 'http://localhost:8000', timeoutMs: 10_000 },
    auth: {
      devSeedUserId: '00000000-0000-0000-0000-000000000001',
      devSeedWorkspaceId: '00000000-0000-0000-0000-0000000000a1',
      devAllowContextOverrideHeaders: mode !== 'production',
    },
    webOrigins: ['http://localhost:3000'],
  };
}

describe('selectAuthProvider (Phase 8: production 오발동 방지 가드)', () => {
  it('returns DevAuthContextProvider in development', () => {
    expect(selectAuthProvider(makeConfig('development'))).toBeInstanceOf(DevAuthContextProvider);
  });

  it('returns DevAuthContextProvider in test mode', () => {
    expect(selectAuthProvider(makeConfig('test'))).toBeInstanceOf(DevAuthContextProvider);
  });

  it('refuses to start in production — no real AuthContextProvider exists yet', () => {
    expect(() => selectAuthProvider(makeConfig('production'))).toThrow(AuthProviderConfigurationError);
  });
});
