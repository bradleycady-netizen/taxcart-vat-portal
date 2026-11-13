import { ProviderError } from '../core/errors.ts';
import type { ProviderAdapter, ProviderConnection } from '../core/types.ts';
import { decryptSecret } from '../core/secretbox.ts';
import { ZampAdapter } from './zamp/adapter.ts';

export type Env = Record<string, string | undefined>;

export interface AdapterDeps {
  /** Injectable HTTP client for tests. */
  fetchImpl?: typeof fetch;
}

export type AdapterFactory = (connection: ProviderConnection, env: Env, deps: AdapterDeps) => ProviderAdapter;

/**
 * provider_key -> how to build that provider's adapter.
 *
 * To add a provider (e.g. the VAT vendor): write src/providers/<vendor>/adapter.ts implementing
 * ProviderAdapter, then register it here. Nothing else in the codebase changes.
 */
const factories = new Map<string, AdapterFactory>([
  [
    'zamp',
    (connection, env, deps) => {
      const apiKey = readCredential(connection, env);
      const baseUrl = env['ZAMP_BASE_URL'];
      return new ZampAdapter({
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    },
  ],
]);

/** Keys of every provider the portal can talk to (staff screens only). */
export function knownProviders(): string[] {
  return [...factories.keys()];
}

export function isKnownProvider(providerKey: string): boolean {
  return factories.has(providerKey);
}

export function registerAdapter(providerKey: string, factory: AdapterFactory): void {
  factories.set(providerKey, factory);
}

export function buildAdapter(connection: ProviderConnection, env: Env, deps: AdapterDeps = {}): ProviderAdapter {
  const factory = factories.get(connection.providerKey);
  if (!factory) {
    throw new ProviderError('config', connection.providerKey, `No adapter registered for provider "${connection.providerKey}"`);
  }
  return factory(connection, env, deps);
}

/**
 * Find this connection's secret. A token stored in the database (encrypted) wins; otherwise the secret NAMED by
 * connection.credentialRef is read from the environment (the original method, still used for shared/partner keys).
 */
export function readCredential(connection: ProviderConnection, env: Env): string {
  if (connection.credentialEnc) {
    try {
      return decryptSecret(connection.credentialEnc, env['CREDENTIAL_ENCRYPTION_KEY']);
    } catch (err) {
      throw new ProviderError('config', connection.providerKey, err instanceof Error ? err.message : 'Stored credential is unreadable');
    }
  }
  const name = connection.credentialRef;
  const value = name ? env[name] : undefined;
  if (!value) {
    throw new ProviderError(
      'config',
      connection.providerKey,
      name ? `Credential "${name}" is not set in the environment` : 'This connection has no credential configured',
    );
  }
  return value;
}
