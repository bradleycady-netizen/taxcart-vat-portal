import type { AppConfig } from './config.ts';
import type { AuthUser, SessionTokens } from './authApi.ts';
import { errorResponse } from './util.ts';
import type { Deps } from './types.ts';

/**
 * Sessions live in httpOnly cookies, so page scripts (and therefore any injected script) can never read
 * the tokens. SameSite=Lax plus the Origin check on every POST defends against cross-site requests.
 */

/** Over https the cookies use the __Host- prefix, which stops other subdomains from overwriting them. */
export function cookieNames(config: AppConfig): { access: string; refresh: string } {
  const prefix = config.secureCookies ? '__Host-' : '';
  return { access: `${prefix}tc_at`, refresh: `${prefix}tc_rt` };
}

function serialize(name: string, value: string, maxAgeSeconds: number, config: AppConfig): string {
  if (/[\s;,"\\]/.test(value)) throw new Error('refusing to write a cookie value with unsafe characters');
  const parts = [`${name}=${value}`, 'Path=/', `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`, 'HttpOnly', 'SameSite=Lax'];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

export function buildSessionCookies(tokens: SessionTokens, config: AppConfig): string[] {
  const names = cookieNames(config);
  return [
    serialize(names.access, tokens.accessToken, tokens.expiresIn, config),
    serialize(names.refresh, tokens.refreshToken, config.sessionDays * 86_400, config),
  ];
}

export function buildClearCookies(config: AppConfig): string[] {
  const names = cookieNames(config);
  return [serialize(names.access, '', 0, config), serialize(names.refresh, '', 0, config)];
}

export function readSessionCookies(request: Request, config: AppConfig): { accessToken: string | null; refreshToken: string | null } {
  const names = cookieNames(config);
  const jar = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return { accessToken: jar.get(names.access) || null, refreshToken: jar.get(names.refresh) || null };
}

export type Authenticated =
  | { ok: true; user: AuthUser; accessToken: string; setCookies: string[] }
  | { ok: false; response: Response };

const UNAVAILABLE = () => errorResponse(503, 'unavailable', 'We could not complete that right now. Please try again shortly.');

/**
 * Works out who is making the request. An expired access token is renewed transparently from the refresh
 * token; any cookies that need setting are returned in `setCookies` and MUST be attached to the response.
 *
 * - no usable session      -> 401, and stale cookies are cleared
 * - sign-in service down   -> 503, cookies left alone (the person is still signed in)
 */
export async function authenticate(request: Request, deps: Pick<Deps, 'auth' | 'config'>): Promise<Authenticated> {
  const { config, auth } = deps;
  const { accessToken, refreshToken } = readSessionCookies(request, config);
  const hadCookies = accessToken !== null || refreshToken !== null;

  const unauthorized = (): Authenticated => ({
    ok: false,
    response: errorResponse(401, 'unauthenticated', 'Please sign in.', hadCookies ? { setCookies: buildClearCookies(config) } : {}),
  });

  if (accessToken) {
    const u = await auth.getUser(accessToken);
    if (u.ok) return { ok: true, user: u.user, accessToken, setCookies: [] };
    if (u.reason === 'unavailable') return { ok: false, response: UNAVAILABLE() };
  }

  if (!refreshToken) return unauthorized();

  const r = await auth.refresh(refreshToken);
  if (r.ok) return { ok: true, user: r.user, accessToken: r.tokens.accessToken, setCookies: buildSessionCookies(r.tokens, config) };
  if (r.reason === 'invalid') return unauthorized();
  return { ok: false, response: UNAVAILABLE() };
}
