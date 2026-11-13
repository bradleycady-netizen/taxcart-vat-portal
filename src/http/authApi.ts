import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from './types.ts';

/**
 * The sign-in operations the portal needs, independent of who provides them.
 * Supabase Auth is the first implementation: it generates, emails and verifies the one-time codes,
 * so no code-handling logic is written (or can be got wrong) here.
 */
export interface AuthUser {
  id: string;
  email: string;
  /** True only if app_metadata.taxcart_staff is set. app_metadata can only be changed server-side. */
  isStaff: boolean;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

/**
 * sent        = a code was sent
 * rejected    = the provider declined (unknown email, cooldown, rate limit). Callers MUST treat this the
 *               same as 'sent' so the response never reveals whether an email is registered.
 * unavailable = the provider could not be reached or failed; safe to tell the user to retry.
 */
export type SendCodeResult = 'sent' | 'rejected' | 'unavailable';

export type TokenResult =
  | { ok: true; tokens: SessionTokens; user: AuthUser }
  | { ok: false; reason: 'invalid' | 'rate_limited' | 'unavailable' };

export type UserResult = { ok: true; user: AuthUser } | { ok: false; reason: 'invalid' | 'unavailable' };

export interface AuthApi {
  sendCode(email: string): Promise<SendCodeResult>;
  verifyCode(email: string, code: string): Promise<TokenResult>;
  refresh(refreshToken: string): Promise<TokenResult>;
  /** Validates an access token with the provider (also catches revoked sessions). */
  getUser(accessToken: string): Promise<UserResult>;
  /** Ends the session at the provider. Best effort. */
  revoke(accessToken: string): Promise<void>;
  /**
   * Makes sure a sign-in account exists for this email (invite-only: staff create accounts, people cannot self-register).
   * Returns its id, or null if the provider could not do it. Staff-side use only.
   */
  ensureUser(email: string): Promise<{ id: string; created: boolean } | null>;
}

type AuthErrorLike = { status?: number; code?: string; message?: string } | null | undefined;

/** network failure / 5xx -> 'server', 429 -> 'rate', any other 4xx -> 'client' */
function classify(error: AuthErrorLike): 'server' | 'rate' | 'client' {
  const status = error?.status;
  if (status === undefined || status === 0 || status >= 500) return 'server';
  if (status === 429) return 'rate';
  return 'client';
}

function toUser(u: unknown): AuthUser | null {
  const o = u as { id?: unknown; email?: unknown; app_metadata?: { taxcart_staff?: unknown } } | null;
  if (!o || typeof o.id !== 'string' || typeof o.email !== 'string') return null;
  return { id: o.id, email: o.email.toLowerCase(), isStaff: o.app_metadata?.taxcart_staff === true };
}

function toSession(session: unknown, fallbackUser: unknown): { tokens: SessionTokens; user: AuthUser } | null {
  const s = session as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; user?: unknown } | null;
  if (!s || typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string') return null;
  const user = toUser(s.user ?? fallbackUser);
  if (!user) return null;
  const expiresIn = typeof s.expires_in === 'number' && s.expires_in > 0 ? s.expires_in : 3600;
  return { tokens: { accessToken: s.access_token, refreshToken: s.refresh_token, expiresIn }, user };
}

/**
 * Supabase Auth implementation.
 *
 * `makeClient` must return a FRESH anon-key client each call (created with persistSession:false,
 * autoRefreshToken:false). A fresh client per call matters: supabase-js keeps the last session in
 * memory, and sharing one client across requests could let one visitor's session leak into another's.
 * `admin` is a service-role client, used only to end sessions.
 *
 * NOTE: written against supabase-js v2's documented behaviour but not yet run against a live project.
 */
export class SupabaseAuthApi implements AuthApi {
  private readonly makeClient: () => SupabaseClient;
  private readonly admin: SupabaseClient;
  private readonly log: Logger;

  constructor(makeClient: () => SupabaseClient, admin: SupabaseClient, log: Logger = () => {}) {
    this.makeClient = makeClient;
    this.admin = admin;
    this.log = log;
  }

  async sendCode(email: string): Promise<'sent' | 'rejected' | 'unavailable'> {
    try {
      const { error } = await this.makeClient().auth.signInWithOtp({
        email,
        // Invite-only: never create an account just because someone typed an email.
        options: { shouldCreateUser: false },
      });
      if (!error) return 'sent';
      if (classify(error) === 'server') {
        this.log('auth.send_code.unavailable', { status: error.status ?? null, code: error.code ?? null });
        return 'unavailable';
      }
      // Unknown email, a per-user cooldown, or a rate limit. Logged WITHOUT the email, so a project-wide
      // email limit (which would silently stop everyone's codes) is still visible to operators.
      this.log('auth.send_code.rejected', { status: error.status ?? null, code: error.code ?? null });
      return 'rejected';
    } catch {
      this.log('auth.send_code.unavailable', { thrown: true });
      return 'unavailable';
    }
  }

  async verifyCode(email: string, code: string): Promise<TokenResult> {
    try {
      const { data, error } = await this.makeClient().auth.verifyOtp({ email, token: code, type: 'email' });
      if (error) {
        const kind = classify(error);
        return { ok: false, reason: kind === 'server' ? 'unavailable' : kind === 'rate' ? 'rate_limited' : 'invalid' };
      }
      const s = toSession(data?.session, data?.user);
      return s ? { ok: true, ...s } : { ok: false, reason: 'invalid' };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async refresh(refreshToken: string): Promise<TokenResult> {
    try {
      const { data, error } = await this.makeClient().auth.refreshSession({ refresh_token: refreshToken });
      if (error) {
        const kind = classify(error);
        return { ok: false, reason: kind === 'server' ? 'unavailable' : kind === 'rate' ? 'rate_limited' : 'invalid' };
      }
      const s = toSession(data?.session, data?.user);
      return s ? { ok: true, ...s } : { ok: false, reason: 'invalid' };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async getUser(accessToken: string): Promise<UserResult> {
    try {
      const { data, error } = await this.makeClient().auth.getUser(accessToken);
      if (error) return { ok: false, reason: classify(error) === 'server' ? 'unavailable' : 'invalid' };
      const user = toUser(data?.user);
      return user ? { ok: true, user } : { ok: false, reason: 'invalid' };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async ensureUser(email: string): Promise<{ id: string; created: boolean } | null> {
    try {
      const made = await this.admin.auth.admin.createUser({ email, email_confirm: true });
      const id = (made.data?.user as { id?: unknown } | null | undefined)?.id;
      if (!made.error && typeof id === 'string') return { id, created: true };
      // Most likely "already registered": look the existing account up.
      const found = await this.admin.rpc('auth_user_id_by_email', { p_email: email });
      if (!found.error && typeof found.data === 'string') return { id: found.data, created: false };
      this.log('auth.ensure_user_failed', { status: made.error?.status ?? null });
      return null;
    } catch {
      this.log('auth.ensure_user_failed', { thrown: true });
      return null;
    }
  }

  async revoke(accessToken: string): Promise<void> {
    try {
      await this.admin.auth.admin.signOut(accessToken, 'local');
    } catch {
      this.log('auth.revoke_failed');
    }
  }
}
