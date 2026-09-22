import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../bff/src/config/index.js';
import { DevAuthContextProvider } from '../../bff/src/client-context/DevAuthContextProvider.js';

function buildProvider(overrides: Partial<ReturnType<typeof loadConfig>['auth']> = {}) {
  const config = loadConfig();
  return new DevAuthContextProvider({
    ...config,
    auth: { ...config.auth, ...overrides },
  });
}

describe('DevAuthContextProvider', () => {
  it('resolves the configured seed userId/workspaceId by default', () => {
    const config = loadConfig();
    const provider = new DevAuthContextProvider(config);

    const context = provider.resolve({ headers: {} });

    expect(context.userId).toBe(config.auth.devSeedUserId);
    expect(context.workspaceId).toBe(config.auth.devSeedWorkspaceId);
    expect(context.requestId).toBeTruthy();
    expect(context.conversationId).toBeNull();
  });

  it('generates a fresh requestId per call when none is supplied', () => {
    const provider = buildProvider();
    const a = provider.resolve({ headers: {} });
    const b = provider.resolve({ headers: {} });
    expect(a.requestId).not.toBe(b.requestId);
  });

  it('honors an incoming x-request-id header instead of generating one', () => {
    const provider = buildProvider();
    const context = provider.resolve({ headers: { 'x-request-id': 'req-fixed-123' } });
    expect(context.requestId).toBe('req-fixed-123');
  });

  it('allows overriding userId/workspaceId via dev headers when enabled', () => {
    const provider = buildProvider({ devAllowContextOverrideHeaders: true });

    const context = provider.resolve({
      headers: {
        'x-dev-user-id': 'user-override',
        'x-dev-workspace-id': 'workspace-override',
      },
    });

    expect(context.userId).toBe('user-override');
    expect(context.workspaceId).toBe('workspace-override');
  });

  it('ignores dev override headers when overrides are disabled (e.g. production)', () => {
    const config = loadConfig();
    const provider = buildProvider({ devAllowContextOverrideHeaders: false });

    const context = provider.resolve({
      headers: {
        'x-dev-user-id': 'user-override',
        'x-dev-workspace-id': 'workspace-override',
      },
    });

    expect(context.userId).toBe(config.auth.devSeedUserId);
    expect(context.workspaceId).toBe(config.auth.devSeedWorkspaceId);
  });

  it('carries an optional conversationId through when supplied', () => {
    const provider = buildProvider();
    const context = provider.resolve({ headers: { 'x-conversation-id': 'conv-1' } });
    expect(context.conversationId).toBe('conv-1');
  });
});
