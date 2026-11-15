import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SecretBoxError, decryptSecret, encryptSecret } from '../src/core/secretbox.ts';
import { ProviderError } from '../src/core/errors.ts';
import { buildAdapter, readCredential } from '../src/providers/registry.ts';
import { connection } from './helpers.ts';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

test('a secret survives a round trip, and the stored text never contains it', () => {
  const stored = encryptSecret('zamp-token-abc123', KEY);
  assert.ok(stored.startsWith('v1.'));
  assert.ok(!stored.includes('zamp-token-abc123'));
  assert.equal(decryptSecret(stored, KEY), 'zamp-token-abc123');
});

test('the same secret encrypts differently each time (fresh random IV)', () => {
  assert.notEqual(encryptSecret('same', KEY), encryptSecret('same', KEY));
});

test('a wrong key, an altered value or a missing key is refused, with a vague message', () => {
  const stored = encryptSecret('zamp-token-abc123', KEY);
  assert.throws(() => decryptSecret(stored, OTHER_KEY), SecretBoxError);
  const parts = stored.split('.');
  parts[3] = Buffer.from('tampered-bytes').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), KEY), SecretBoxError);
  assert.throws(() => decryptSecret('not-a-valid-value', KEY), SecretBoxError);
  assert.throws(() => encryptSecret('x', undefined), /not set/);
  assert.throws(() => encryptSecret('x', 'too-short'), /32 random bytes/);
});

test('hex keys of 64 characters are accepted', () => {
  const hex = randomBytes(32).toString('hex');
  assert.equal(decryptSecret(encryptSecret('t', hex), hex), 't');
});

test('a connection with a stored token uses it, ignoring any environment variable of the same name', () => {
  const c = connection({ providerKey: 'zamp', credentialRef: 'ZAMP_PARTNER_KEY', credentialEnc: encryptSecret('per-client-token', KEY) });
  assert.equal(readCredential(c, { CREDENTIAL_ENCRYPTION_KEY: KEY, ZAMP_PARTNER_KEY: 'shared' }), 'per-client-token');
});

test('without a stored token the named environment variable is used, as before', () => {
  const c = connection({ providerKey: 'zamp', credentialRef: 'ZAMP_PARTNER_KEY' });
  assert.equal(readCredential(c, { ZAMP_PARTNER_KEY: 'shared' }), 'shared');
});

test('a stored token that cannot be decrypted is a configuration problem, not a crash', () => {
  const c = connection({ providerKey: 'zamp', credentialRef: null, credentialEnc: encryptSecret('t', KEY) });
  assert.throws(() => readCredential(c, { CREDENTIAL_ENCRYPTION_KEY: OTHER_KEY }), (e: unknown) => e instanceof ProviderError && e.kind === 'config');
  assert.throws(() => readCredential(c, {}), (e: unknown) => e instanceof ProviderError && e.kind === 'config');
  assert.throws(() => buildAdapter(connection({ providerKey: 'zamp', credentialRef: null }), {}), /no credential configured/);
});

test('a stored token is what the Zamp adapter sends', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>)['Authorization'] ?? (init?.headers as Headers)?.get?.('authorization') ?? ''));
    return new Response(JSON.stringify([{ id: 'x' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const c = connection({ providerKey: 'zamp', credentialRef: null, credentialEnc: encryptSecret('per-client-token', KEY) });
  const adapter = buildAdapter(c, { CREDENTIAL_ENCRYPTION_KEY: KEY }, { fetchImpl });
  await adapter.healthCheck({ providerCompanyId: null }).catch(() => {});
  assert.ok(seen.some((h) => h.includes('per-client-token')), `expected the stored token in the request, saw: ${seen.join('|')}`);
});
