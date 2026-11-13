import { LIMITS, type Rule } from '../limits.ts';
import { authenticate, buildClearCookies, buildSessionCookies, readSessionCookies } from '../session.ts';
import type { Deps } from '../types.ts';
import {
  HttpError,
  bucketKey,
  clientIp,
  errorResponse,
  jsonResponse,
  normalizeEmail,
  readJsonObject,
  requireAllowedOrigin,
  requireMethod,
  toErrorResponse,
} from '../util.ts';

const UNAVAILABLE = new HttpError(503, 'unavailable', 'We could not complete that right now. Please try again shortly.');
const RATE_LIMITED_MESSAGE = 'Too many attempts. Please wait a few minutes and try again.';

/** Records an attempt against a bucket; true = allowed. A throttle outage fails CLOSED (503), never open. */
async function allow(deps: Deps, kind: string, value: string, rule: Rule): Promise<boolean> {
  try {
    return await deps.throttle.hit(bucketKey(deps.config.throttleSecret, kind, value), rule.limit, rule.windowSeconds);
  } catch {
    deps.log('throttle.unavailable');
    throw UNAVAILABLE;
  }
}

function tooManyAttempts(windowSeconds: number): Response {
  return errorResponse(429, 'rate_limited', RATE_LIMITED_MESSAGE, { headers: { 'Retry-After': String(windowSeconds) } });
}

/**
 * POST /api/auth/request-code  { email }
 *
 * Always answers the same way for registered and unregistered addresses, so the form cannot be used to
 * discover who has an account.
 */
export async function requestCode(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'POST');
    requireAllowedOrigin(request, deps.config);
    const body = await readJsonObject(request);
    const email = normalizeEmail(body['email']);

    const rule = LIMITS.requestCode;
    if (!(await allow(deps, 'rc-ip', clientIp(request), rule.perIp))) return tooManyAttempts(rule.perIp.windowSeconds);
    if (!(await allow(deps, 'rc-email', email, rule.perEmail))) return tooManyAttempts(rule.perEmail.windowSeconds);

    const result = await deps.auth.sendCode(email);
    if (result === 'unavailable') throw UNAVAILABLE;

    // 'sent' and 'rejected' are deliberately indistinguishable.
    return jsonResponse({ ok: true, message: 'If that email address is registered, a sign-in code is on its way.' });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

/** POST /api/auth/verify-code  { email, code }  ->  sets the session cookies */
export async function verifyCode(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'POST');
    requireAllowedOrigin(request, deps.config);
    const body = await readJsonObject(request);
    const email = normalizeEmail(body['email']);
    const code = typeof body['code'] === 'string' ? body['code'].trim() : '';
    if (!/^\d{6,10}$/.test(code)) throw new HttpError(400, 'invalid_input', 'Enter the numeric code from your email.');

    const rule = LIMITS.verifyCode;
    if (!(await allow(deps, 'vc-ip', clientIp(request), rule.perIp))) return tooManyAttempts(rule.perIp.windowSeconds);
    if (!(await allow(deps, 'vc-email', email, rule.perEmail))) return tooManyAttempts(rule.perEmail.windowSeconds);

    const result = await deps.auth.verifyCode(email, code);
    if (!result.ok) {
      if (result.reason === 'rate_limited') return tooManyAttempts(rule.perEmail.windowSeconds);
      if (result.reason === 'unavailable') throw UNAVAILABLE;
      return errorResponse(401, 'invalid_code', 'That code is incorrect or has expired.');
    }

    // A correct code clears this address's failed-attempt count, so an earlier typo never locks someone out.
    try {
      await deps.throttle.reset(bucketKey(deps.config.throttleSecret, 'vc-email', email));
    } catch {
      deps.log('throttle.reset_failed');
    }
    try {
      await deps.audit.record({ actorId: result.user.id, action: 'auth.login' });
    } catch {
      deps.log('audit.login_not_recorded'); // a logging problem must not lock people out
    }

    return jsonResponse(
      { ok: true, user: { email: result.user.email, isStaff: result.user.isStaff } },
      200,
      { setCookies: buildSessionCookies(result.tokens, deps.config) },
    );
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

/** POST /api/auth/logout. Always succeeds from the browser's point of view. */
export async function logout(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'POST');
    requireAllowedOrigin(request, deps.config);
    const { accessToken } = readSessionCookies(request, deps.config);
    if (accessToken) {
      try {
        await deps.auth.revoke(accessToken);
      } catch {
        deps.log('auth.revoke_failed');
      }
    }
    return jsonResponse({ ok: true }, 200, { setCookies: buildClearCookies(deps.config) });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

type SyncStatus = 'ok' | 'stale' | 'pending';

/** What the portal shows about data freshness: never synced / last refresh failed / fine. */
export function syncStatus(row: { last_synced_at: unknown; last_sync_status: unknown }): SyncStatus {
  if (row.last_synced_at === null || row.last_synced_at === undefined) return 'pending';
  return row.last_sync_status === 'failed' ? 'stale' : 'ok';
}

/**
 * GET /api/session. Who is signed in, which clients (tenants) they belong to, and which products each has
 * (so the portal can branch to US Sales Tax or VAT). Contains nothing about which vendor serves anyone.
 */
export async function getSession(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'GET');
    const a = await authenticate(request, deps);
    if (!a.ok) return a.response;

    const db = deps.userDb(a.accessToken);
    const members = await db.from('tenant_members').select('tenant_id').eq('user_id', a.user.id);
    if (members.error) throw new Error('could not load memberships');
    const ids = (members.data ?? []).map((m) => String((m as Record<string, unknown>)['tenant_id']));

    let tenants: Record<string, unknown>[] = [];
    let products: Record<string, unknown>[] = [];
    let logoFor = new Set<string>();
    if (ids.length > 0) {
      const t = await db.from('tenants').select('id,name').in('id', ids);
      const p = await db
        .from('tenant_products')
        .select('tenant_id,product,is_active,last_synced_at,last_sync_status')
        .in('tenant_id', ids);
      const l = await db.from('tenant_logos').select('tenant_id').in('tenant_id', ids);
      if (t.error || p.error || l.error) throw new Error('could not load tenants or products');
      logoFor = new Set(((l.data ?? []) as Record<string, unknown>[]).map((r) => String(r['tenant_id'])));
      tenants = (t.data ?? []) as Record<string, unknown>[];
      products = (p.data ?? []) as Record<string, unknown>[];
    }

    return jsonResponse(
      {
        user: { email: a.user.email, isStaff: a.user.isStaff },
        tenants: tenants.map((t) => ({
          id: t['id'],
          name: t['name'],
          hasLogo: logoFor.has(String(t['id'])),
          products: products
            .filter((p) => p['tenant_id'] === t['id'] && p['is_active'] === true)
            .map((p) => ({ product: p['product'], lastSyncedAt: p['last_synced_at'] ?? null, syncStatus: syncStatus(p as never) })),
        })),
      },
      200,
      { setCookies: a.setCookies },
    );
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
