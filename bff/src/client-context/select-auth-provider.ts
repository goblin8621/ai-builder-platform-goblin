/**
 * AuthContextProvider selection gate — mirrors Brain's ModelClient
 * selection gate (`brain/app/common/models/selection.py`): the ONLY place
 * that decides which AuthContextProvider is wired, so a dev/test-only
 * implementation can never become a silent production fallback.
 *
 * DevAuthContextProvider always resolves the same seed identity (no real
 * login) — acceptable for development/test, never acceptable once
 * `NODE_ENV=production`. There is no real AuthContextProvider
 * implementation yet (a future real-auth Phase adds one here), so in
 * production this always throws rather than silently running with a fake
 * identity.
 */
import type { AppConfig } from '../config/index.js';
import type { AuthContextProvider } from './AuthContextProvider.js';
import { DevAuthContextProvider } from './DevAuthContextProvider.js';

export class AuthProviderConfigurationError extends Error {}

export function selectAuthProvider(config: AppConfig): AuthContextProvider {
  if (config.mode === 'production') {
    throw new AuthProviderConfigurationError(
      'No real AuthContextProvider is configured. DevAuthContextProvider (a fixed seed ' +
        'identity, no real login) must never run in production. Refusing to start — wire a ' +
        'real AuthContextProvider (e.g. JWT/OAuth) here before setting NODE_ENV=production.',
    );
  }
  return new DevAuthContextProvider(config);
}
