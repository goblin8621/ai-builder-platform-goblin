/**
 * Phase 9 — workspaceRole security rules:
 *  - the Domain never reads a role itself: only the RequestContext made by the AuthContextProvider
 *  - in production nothing a client sends (header / body) can grant admin
 *  - a future real AuthProvider (JWT/RBAC) replaces ONE implementation; no domain code changes
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../bff/src/config/index.js';
import { DevAuthContextProvider } from '../../bff/src/client-context/DevAuthContextProvider.js';
import { AuthProviderConfigurationError, selectAuthProvider } from '../../bff/src/client-context/select-auth-provider.js';
import { canManageDocumentExport } from '../../bff/src/skill-exports/export-permissions.js';
import { buildServer } from '../../bff/src/server.js';
import type { AuthContextProvider } from '../../bff/src/client-context/AuthContextProvider.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '../../bff/src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}
const rel = (file: string) => path.relative(srcDir, file);

const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  if (originalEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv;
});

describe('workspaceRole is resolved ONLY by the AuthContextProvider', () => {
  it('no module outside client-context reads a role from headers, env or the request', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      if (rel(file).startsWith('client-context/') || rel(file) === 'config/index.ts') continue;
      const text = readFileSync(file, 'utf-8');
      if (/x-dev-workspace-role|x-workspace-role|DEV_WORKSPACE_ROLE|headers\[['"][^'"]*role/i.test(text)) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it('the domain only ever consumes `context.workspaceRole` (never request.headers / body for authorization)', () => {
    const readers = sourceFiles(srcDir)
      .filter((file) => /workspaceRole/.test(readFileSync(file, 'utf-8')))
      .map(rel)
      .sort();
    // the provider that PRODUCES the role + the single predicate that CONSUMES it
    expect(readers).toEqual(['client-context/DevAuthContextProvider.ts', 'skill-exports/export-permissions.ts']);
  });

  it('document export routes authorize through canManageDocumentExport(request.appContext)', () => {
    const routes = readFileSync(path.join(srcDir, 'documents/routes.ts'), 'utf-8');
    expect(routes).toContain('canManageDocumentExport(request.appContext)');
    expect(routes).not.toMatch(/request\.headers|request\.body[^;]*[rR]ole/);
  });
});

describe('production cannot be talked into admin', () => {
  it('the dev identity provider (and its override headers) refuses to run in production', () => {
    process.env.NODE_ENV = 'production';
    const config = loadConfig();
    expect(config.mode).toBe('production');
    expect(config.auth.devAllowContextOverrideHeaders).toBe(false);
    expect(() => selectAuthProvider(config)).toThrow(AuthProviderConfigurationError);
    expect(() => buildServer()).toThrow(AuthProviderConfigurationError); // the server does not even start
  });

  it('even a mistakenly constructed dev provider ignores the role header when overrides are disabled', () => {
    process.env.NODE_ENV = 'production';
    const config = loadConfig();
    const provider = new DevAuthContextProvider({ ...config, auth: { ...config.auth, devWorkspaceRole: 'member' } });
    const context = provider.resolve({ headers: { 'x-dev-workspace-role': 'admin' } });
    expect(context.workspaceRole).toBe('member');
  });

  it('a missing role is least privilege', () => {
    expect(canManageDocumentExport({ userId: 'u', workspaceId: 'w', requestId: 'r' })).toBe(false);
    expect(canManageDocumentExport({ userId: 'u', workspaceId: 'w', requestId: 'r', workspaceRole: 'member' })).toBe(false);
  });
});

describe('a real AuthProvider replaces only the provider', () => {
  it('any AuthContextProvider that returns workspaceRole drives the same permission predicate', () => {
    const jwtLike: AuthContextProvider = {
      resolve: () => ({ userId: 'u-1', workspaceId: 'w-1', requestId: 'r-1', workspaceRole: 'admin' }),
    };
    expect(canManageDocumentExport(jwtLike.resolve({ headers: {} }))).toBe(true);
    const memberProvider: AuthContextProvider = {
      resolve: () => ({ userId: 'u-2', workspaceId: 'w-1', requestId: 'r-2', workspaceRole: 'member' }),
    };
    expect(canManageDocumentExport(memberProvider.resolve({ headers: {} }))).toBe(false);
  });
});
