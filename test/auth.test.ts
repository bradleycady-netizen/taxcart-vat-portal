import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSession, logout, requestCode, verifyCode } from '../src/http/handlers/auth.ts';
import { LIMITS } from '../src/http/limits.ts';
import { loadConfig, ConfigError } from '../src/http/config.ts';
import {
  ORIGIN, TEST_ENV, USER_A, USER_B, USER_STAFF, T_B,
  body, cookieHeaderFrom, cookiesFor, get, harness, post,
} from './httpHelpers.ts';

// ------------------------------------------------------------------ requesting a code

test('request-code sends a code to the normalised address and answers generically', async () => {
  const h = harness();
  const res = await requestCode(post('/api/auth/request-code', { email: '  Ann@Acme.TEST ' }), h.deps);
  assert.equal(res.status, 200);
  assert.deepEqual(h.auth.calls.send, ['ann@acme.test']);
  assert.match((await body(res))['message'], /If that email address is registered/);
});

test('registered and unregistered addresses get byte-identical responses (no account discovery)', async () => {
  const known = harness();
  const unknown = harness();
  unknown.auth.sendResult = 'rejected'; // the provider declines unknown emails (and cooldowns)

  const a = await requestCode(post('/api/auth/request-code', { email: 'ann@acme.test' }), known.deps);
  const b = await requestCode(post('/api/auth/request-code', { email: 'nobody@nowhere.test' }), unknown.deps);

  assert.equal(a.status, b.status);
  assert.equal(await a.text(), await b.text());
  assert.equal([...a.headers.keys()].sort().join(), [...b.headers.keys()].sort().join());
});

test('request-code refuses bad requests before doing anything', async () => {
  const h = harness();
  const cases: [string, Request, number][] = [
    ['missing Origin', post('/api/auth/request-code', { email: 'a@b.co' }, { origin: null }), 403],
    ['foreign Origin', post('/api/auth/request-code', { email: 'a@b.co' }, { origin: 'https://evil.example' }), 403],
    ['not JSON content type', post('/api/auth/request-code', { email: 'a@b.co' }, { contentType: 'text/plain' }), 415],
    ['no content type (plain form post)', post('/api/auth/request-code', { email: 'a@b.co' }, { contentType: null }), 415],
    ['bad email', post('/api/auth/request-code', { email: 'not-an-email' }), 400],
    ['non-string email', post('/api/auth/request-code', { email: ['a@b.co'] }), 400],
    ['broken JSON', post('/api/auth/request-code', null, { raw: '{nope' }), 400],
    ['array body', post('/api/auth/request-code', ['a@b.co']), 400],
    ['oversized body', post('/api/auth/request-code', { email: 'a@b.co', pad: 'x'.repeat(5000) }), 413],
    ['wrong method', get('/api/auth/request-code'), 405],
  ];
  for (const [name, req, status] of cases) {
    assert.equal((await requestCode(req, h.deps)).status, status, name);
  }
  assert.equal(h.auth.calls.send.length, 0, 'nothing should have been sent');
});

test('request-code is limited per address, and case/spacing variants share one limit', async () => {
  const h = harness();
  const { limit, windowSeconds } = LIMITS.requestCode.perEmail;
  const variants = ['ann@acme.test', 'ANN@ACME.TEST', ' Ann@Acme.test ', 'ann@acme.test', 'ANN@acme.test'];
  assert.equal(variants.length, limit);
  for (const email of variants) {
    assert.equal((await requestCode(post('/api/auth/request-code', { email }), h.deps)).status, 200);
  }
  const blocked = await requestCode(post('/api/auth/request-code', { email: 'ann@acme.test' }), h.deps);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), String(windowSeconds));
  assert.equal(h.auth.calls.send.length, limit, 'blocked attempts must not trigger an email');
});

test('request-code is limited per source address across different emails', async () => {
  const h = harness();
  const { limit } = LIMITS.requestCode.perIp;
  for (let i = 0; i < limit; i++) {
    assert.equal((await requestCode(post('/api/auth/request-code', { email: `user${i}@x.test` }, { ip: '198.51.100.9' }), h.deps)).status, 200);
  }
  assert.equal((await requestCode(post('/api/auth/request-code', { email: 'one-more@x.test' }, { ip: '198.51.100.9' }), h.deps)).status, 429);
  assert.equal((await requestCode(post('/api/auth/request-code', { email: 'one-more@x.test' }, { ip: '198.51.100.10' }), h.deps)).status, 200, 'another address is unaffected');
});

test('the throttle never stores raw emails or IP addresses', async () => {
  const h = harness();
  await requestCode(post('/api/auth/request-code', { email: 'ann@acme.test' }, { ip: '203.0.113.99' }), h.deps);
  await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code: '000000' }, { ip: '203.0.113.99' }), h.deps);
  const keys = [...h.throttle.hits.keys()];
  assert.equal(keys.length, 4);
  for (const k of keys) {
    assert.match(k, /^[0-9a-f]{64}$/);
    assert.ok(!k.includes('ann') && !k.includes('203.0.113'));
  }
});

test('if the sign-in service is down the person is told to retry; if the throttle is down we fail closed', async () => {
  const down = harness();
  down.auth.sendResult = 'unavailable';
  assert.equal((await requestCode(post('/api/auth/request-code', { email: 'ann@acme.test' }), down.deps)).status, 503);

  const noThrottle = harness();
  noThrottle.throttle.failing = true;
  const res = await requestCode(post('/api/auth/request-code', { email: 'ann@acme.test' }), noThrottle.deps);
  assert.equal(res.status, 503);
  assert.equal(noThrottle.auth.calls.send.length, 0, 'with no throttle, nothing may be sent');
});

// ------------------------------------------------------------------ verifying a code

test('a correct code signs the person in with httpOnly cookies, and tokens never appear in the body', async () => {
  const h = harness();
  const res = await verifyCode(post('/api/auth/verify-code', { email: 'ANN@acme.test', code: '123456' }), h.deps);
  assert.equal(res.status, 200);

  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { ok: true, user: { email: 'ann@acme.test', isStaff: false } });
  assert.ok(!/access-|refresh-/.test(text), 'tokens must not be in the response body');

  const [access, refresh] = res.headers.getSetCookie();
  assert.ok(access!.startsWith('__Host-tc_at=access-'));
  assert.ok(refresh!.startsWith('__Host-tc_rt=refresh-'));
  for (const c of [access!, refresh!]) {
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(c.includes(flag), `${flag} missing from ${c.split('=')[0]}`);
    assert.ok(!/Domain=/i.test(c), '__Host- cookies must not set a Domain');
  }
  assert.match(access!, /Max-Age=3600\b/);
  assert.match(refresh!, new RegExp(`Max-Age=${14 * 86400}\\b`));
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(h.audit.entries.map((e) => [e.action, e.actorId]), [['auth.login', USER_A.id]]);
});

test('wrong and expired codes get one generic answer', async () => {
  const h = harness();
  const wrong = await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code: '999999' }), h.deps);
  const unknown = await verifyCode(post('/api/auth/verify-code', { email: 'nobody@nowhere.test', code: '999999' }), h.deps);
  assert.equal(wrong.status, 401);
  assert.equal(await wrong.text(), await unknown.text());
  assert.equal(wrong.headers.getSetCookie().length, 0);
});

test('guessing is locked out after the limit, even if the next guess happens to be right', async () => {
  const h = harness();
  const { limit } = LIMITS.verifyCode.perEmail;
  for (let i = 0; i < limit; i++) {
    assert.equal((await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code: `00000${i}` }), h.deps)).status, 401);
  }
  const locked = await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code: '123456' }), h.deps);
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.getSetCookie().length, 0);
  assert.equal(h.auth.calls.verify.length, limit, 'the locked-out attempt must not even reach the provider');
});

test('a successful sign-in clears the failed-attempt count', async () => {
  const h = harness();
  for (const code of ['000001', '000002', '000003', '000004']) await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code }), h.deps);
  assert.equal((await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code: '123456' }), h.deps)).status, 200);
  // Four more mistakes are tolerated again (they would have been blocked without the reset).
  for (const code of ['000005', '000006', '000007', '000008']) {
    assert.equal((await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code }), h.deps)).status, 401);
  }
});

test('malformed codes are rejected without touching the provider or the throttle', async () => {
  const h = harness();
  for (const code of ['12345', 'abcdef', '12 3456', '', '12345678901', null, 123456]) {
    assert.equal((await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code }), h.deps)).status, 400, String(code));
  }
  assert.equal(h.auth.calls.verify.length, 0);
  assert.equal(h.throttle.hits.size, 0);
});

test('verify-code enforces the same request rules as request-code', async () => {
  const h = harness();
  assert.equal((await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code: '123456' }, { origin: 'https://evil.example' }), h.deps)).status, 403);
  assert.equal((await verifyCode(get('/api/auth/verify-code'), h.deps)).status, 405);
  assert.equal(h.auth.calls.verify.length, 0);
});

test('a sign-in service outage during verification is reported as retryable, not as a wrong code', async () => {
  const down = harness();
  down.auth.down = true;
  assert.equal((await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code: '123456' }), down.deps)).status, 503);
});

test('a problem recording the login does not stop someone signing in', async () => {
  const h = harness();
  h.audit.failing = true;
  assert.equal((await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code: '123456' }), h.deps)).status, 200);
  assert.ok(h.logs.some((l) => l.event === 'audit.login_not_recorded'));
});

test('local development over http uses plain cookie names without Secure', async () => {
  const h = harness({ configOverride: { APP_ORIGIN: 'http://localhost:3000' } });
  const res = await verifyCode(post('/api/auth/verify-code', { email: 'ann@acme.test', code: '123456' }, { origin: 'http://localhost:3000' }), h.deps);
  assert.equal(res.status, 200);
  const [access] = res.headers.getSetCookie();
  assert.ok(access!.startsWith('tc_at='));
  assert.ok(!access!.includes('Secure') && access!.includes('HttpOnly'));
});

// ------------------------------------------------------------------ logout

test('logout ends the session at the provider and clears both cookies', async () => {
  const h = harness();
  const tokens = h.auth.session(USER_A);
  const res = await logout(post('/api/auth/logout', {}, { cookie: cookiesFor(tokens) }), h.deps);
  assert.equal(res.status, 200);
  assert.deepEqual(h.auth.calls.revoke, [tokens.accessToken]);
  const cleared = res.headers.getSetCookie();
  assert.equal(cleared.length, 2);
  assert.ok(cleared.every((c) => /Max-Age=0\b/.test(c) && c.includes('HttpOnly')));
});

test('logout works with no session, and still needs a valid Origin', async () => {
  const h = harness();
  assert.equal((await logout(post('/api/auth/logout', {}), h.deps)).status, 200);
  assert.equal((await logout(post('/api/auth/logout', {}, { origin: 'https://evil.example' }), h.deps)).status, 403);
  assert.equal(h.auth.calls.revoke.length, 0);
});

// ------------------------------------------------------------------ session & token renewal

test('/api/session lists the person, their client, and the products they have, with no vendor detail', async () => {
  const h = harness();
  const tokens = h.auth.session(USER_A);
  const res = await getSession(get('/api/session', { cookie: cookiesFor(tokens) }), h.deps);
  assert.equal(res.status, 200);
  const text = await res.text();
  const data = JSON.parse(text);

  assert.deepEqual(data.user, { email: 'ann@acme.test', isStaff: false });
  assert.equal(data.tenants.length, 1);
  assert.deepEqual(data.tenants[0].products, [
    { product: 'us_sales_tax', lastSyncedAt: '2026-10-22T03:00:00Z', syncStatus: 'ok' },
    { product: 'eu_vat', lastSyncedAt: null, syncStatus: 'pending' },
  ]);
  for (const secret of ['vendor', 'provider', 'credential', 'company-A', 'VENDOR_X', 'connection']) {
    assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `session response mentions "${secret}"`);
  }
  assert.ok(!text.includes('Beta Foods'), "another client's name must not appear");
});

test('a failed last refresh shows as "stale" while keeping the last good time', async () => {
  const h = harness();
  const bob = h.auth.session(USER_B); // client B's last refresh failed in the default fixtures
  const data = await body(await getSession(get('/api/session', { cookie: cookiesFor(bob) }), h.deps));
  assert.equal(data['tenants'][0].id, T_B);
  assert.deepEqual(data['tenants'][0].products, [{ product: 'us_sales_tax', lastSyncedAt: '2026-10-22T03:00:00Z', syncStatus: 'stale' }]);
});

test('an expired access token is renewed from the refresh token, and new cookies are issued', async () => {
  const h = harness();
  const live = h.auth.session(USER_A);
  const expired = cookiesFor({ ...live, accessToken: 'expired.jwt' });
  const res = await getSession(get('/api/session', { cookie: expired }), h.deps);
  assert.equal(res.status, 200);
  assert.deepEqual(h.auth.calls.refresh, [live.refreshToken]);
  const [access, refresh] = res.headers.getSetCookie();
  assert.ok(access!.startsWith('__Host-tc_at=access-') && !access!.includes('expired.jwt'));
  assert.ok(refresh!.startsWith('__Host-tc_rt=refresh-') && !refresh!.includes(live.refreshToken));
});

test('only a refresh token present is enough to get back in', async () => {
  const h = harness();
  const live = h.auth.session(USER_A);
  const res = await getSession(get('/api/session', { cookie: `__Host-tc_rt=${live.refreshToken}` }), h.deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.getSetCookie().length, 2);
});

test('stale or forged cookies are rejected and cleared; no cookies is a plain 401', async () => {
  const h = harness();
  const bad = await getSession(get('/api/session', { cookie: '__Host-tc_at=forged.jwt; __Host-tc_rt=forged' }), h.deps);
  assert.equal(bad.status, 401);
  assert.ok(bad.headers.getSetCookie().every((c) => /Max-Age=0\b/.test(c)));

  const none = await getSession(get('/api/session'), h.deps);
  assert.equal(none.status, 401);
  assert.equal(none.headers.getSetCookie().length, 0);
});

test('cookies without the __Host- prefix are ignored over https', async () => {
  const h = harness();
  const tokens = h.auth.session(USER_A);
  const res = await getSession(get('/api/session', { cookie: cookiesFor(tokens, false) }), h.deps);
  assert.equal(res.status, 401, 'a sibling subdomain could have planted these');
});

test('when the sign-in service is down the person stays signed in (503, cookies untouched)', async () => {
  const h = harness();
  const tokens = h.auth.session(USER_A);
  h.auth.down = true;
  const res = await getSession(get('/api/session', { cookie: cookiesFor(tokens) }), h.deps);
  assert.equal(res.status, 503);
  assert.equal(res.headers.getSetCookie().length, 0);
});

test('staff are identified, and see only the clients they belong to in the session list', async () => {
  const h = harness();
  const tokens = h.auth.session(USER_STAFF);
  const data = await body(await getSession(get('/api/session', { cookie: cookiesFor(tokens) }), h.deps));
  assert.equal(data['user'].isStaff, true);
  assert.deepEqual(data['tenants'], [], 'staff are not members of any client, so the list stays small');
});

test('a user in no client gets an empty list, not an error', async () => {
  const h = harness();
  const nobody = h.auth.session({ id: 'd4444444-0000-4000-8000-000000000004', email: 'new@x.test', isStaff: false });
  const res = await getSession(get('/api/session', { cookie: cookiesFor(nobody) }), h.deps);
  assert.equal(res.status, 200);
  assert.deepEqual((await body(res))['tenants'], []);
});

// ------------------------------------------------------------------ configuration

test('configuration accepts a good setup and applies defaults', () => {
  const c = loadConfig({ ...TEST_ENV });
  assert.deepEqual(c.appOrigins, [ORIGIN]);
  assert.equal(c.secureCookies, true);
  assert.equal(c.sessionDays, 14);
  assert.equal(c.syncBudgetMs, 45_000);
  assert.equal(loadConfig({ ...TEST_ENV, CRON_SECRET: '' }).cronSecret, null);
  assert.deepEqual(loadConfig({ ...TEST_ENV, APP_ORIGIN: 'https://a.example, https://b.example/' }).appOrigins, ['https://a.example', 'https://b.example']);
});

test('configuration refuses unsafe settings and reports every problem at once', () => {
  assert.throws(
    () => loadConfig({ APP_ORIGIN: 'http://portal.example.com', AUTH_THROTTLE_SECRET: 'short', CRON_SECRET: 'short', SESSION_DAYS: '0', SYNC_BUDGET_MS: 'soon' }),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      for (const expected of ['APP_ORIGIN', 'AUTH_THROTTLE_SECRET', 'CRON_SECRET', 'SESSION_DAYS', 'SYNC_BUDGET_MS']) assert.ok(e.message.includes(expected), `missing: ${expected}`);
      return true;
    },
  );
  assert.throws(() => loadConfig({ AUTH_THROTTLE_SECRET: TEST_ENV.AUTH_THROTTLE_SECRET }), /APP_ORIGIN is required/);
  assert.throws(() => loadConfig({ ...TEST_ENV, APP_ORIGIN: 'not a url' }), /not a valid URL/);
  assert.equal(loadConfig({ ...TEST_ENV, APP_ORIGIN: 'http://localhost:3000' }).secureCookies, false);
  assert.equal(loadConfig({ ...TEST_ENV, APP_ORIGIN: 'https://a.example,http://localhost:3000' }).secureCookies, false);
});
