import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts small secrets (a client's provider API token) so they can sit in the database without being readable
 * there. AES-256-GCM: the 'tag' makes any tampering with the stored value fail to decrypt.
 *
 * The key lives ONLY in the environment (CREDENTIAL_ENCRYPTION_KEY), never in the database, so someone who gets a
 * copy of the database still cannot read the tokens. Stored format:  v1.<iv>.<tag>.<ciphertext>  (all base64url).
 */

const PREFIX = 'v1';

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/** The key is 32 random bytes, written as base64 or hex (64 characters). Generate one with: openssl rand -base64 32 */
export function parseKey(raw: string | undefined): Buffer {
  if (!raw) throw new SecretBoxError('CREDENTIAL_ENCRYPTION_KEY is not set');
  const trimmed = raw.trim();
  const buf = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (buf.length !== 32) throw new SecretBoxError('CREDENTIAL_ENCRYPTION_KEY must be 32 random bytes (base64 or 64 hex characters)');
  return buf;
}

export function encryptSecret(plaintext: string, rawKey: string | undefined): string {
  const key = parseKey(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(stored: string, rawKey: string | undefined): string {
  const key = parseKey(rawKey);
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new SecretBoxError('Stored credential is in an unknown format');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or altered data. Deliberately vague.
    throw new SecretBoxError('Stored credential could not be decrypted (wrong key or altered data)');
  }
}
