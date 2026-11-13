import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseAuthApi } from '../src/http/authApi.ts';
import { SupabaseAuditSink } from '../src/http/audit.ts';
import { SupabaseThrottle } from '../src/http/throttle.ts';

type Result = { data?: unknown; error?: { status?: number; code?: string; message?: string } | null };

/** A stand-in for supabase-js's auth client that returns scripted results and records calls. */
function fakeClients(script: Partial<Record<'signInWithOtp' | 'verifyOtp' | 'refreshSession' | 'getUser', Result | Error>> = {}, adminError?: Error) {
  const calls: { method: string; args: unknown[] }[] = [];
  let made = 0;
  const method = (name: keyof typeof script) => async (...args: unknown[]) => {
    calls.push({ method: name, args });
    const r = script[name];
    if (r instanceof Error) throw r;
    return { data: null, error: null, ...(r ?? {}) };
  };
  const makeClient = () => {
    made += 1;
    return { auth: { signInWithOtp: method('signInWithOtp'), verifyOtp: method('verifyOtp'), refreshSession: method('refreshSession'), getUser: method('getUser') } } as unknown as SupabaseClient;
  };
  const admin = {
    auth: { admin: { signOut: async (...args: unknown[]) => { calls.push({ method: 'signOut', args }); if (adminError) throw adminError; return { error: null }; } } },
  } as unknown as SupabaseClient;
  return { makeClient, admin, calls, clientsMade: () => made };
}

const SESSION = {
  access_token: 'at.jwt',
  refresh_token: 'rt',
  expires_in: 1800,
  user: { id: 'u1', email: 'Ann@Acme.test', app_metadata: { taxcart_staff: true }, user_metadata: { taxcart_staff: false } },
};

test('sendCode asks Supabase NOT to create accounts (invite-only)', async () => {
  const f = fakeClients();
  assert.equal(await new SupabaseAuthApi(f.makeClient, f.admin).sendCode('ann@acme.test'), 'sent');
  assert.deepEqual(f.calls[0]!.args, [{ email: 'ann@acme.test', options: { shouldCreateUser: false } }]);
});

test('sendCode: refusals (unknown email, cooldown, rate limit) all read as "rejected"; outages as "unavailable"', async () => {
  for (const status of [400, 403, 422, 429]) {
    const f = fakeClients({ signInWithOtp: { error: { status, code: 'x' } } });
    assert.equal(await new SupabaseAuthApi(f.makeClient, f.admin).sendCode('a@b.co'), 'rejected', String(status));
  }
  for (const err of [{ status: 500 }, { status: 503 }, { status: 0 }, {}]) {
    const f = fakeClients({ signInWithOtp: { error: err } });
    assert.equal(await new SupabaseAuthApi(f.makeClient, f.admin).sendCode('a@b.co'), 'unavailable', JSON.stringify(err));
  }
  const thrown = fakeClients({ signInWithOtp: new Error('network') });
  assert.equal(await new SupabaseAuthApi(thrown.makeClient, thrown.admin).sendCode('a@b.co'), 'unavailable');
});

test('rejections are logged for operators WITHOUT the email address', async () => {
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const f = fakeClients({ signInWithOtp: { error: { status: 429, code: 'over_email_send_rate_limit' } } });
  await new SupabaseAuthApi(f.makeClient, f.admin, (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) })).sendCode('secret.person@example.test');
  assert.equal(logs[0]!.event, 'auth.send_code.rejected');
  assert.deepEqual(logs[0]!.fields, { status: 429, code: 'over_email_send_rate_limit' });
  assert.ok(!JSON.stringify(logs).includes('secret.person'));
});

test('verifyCode returns tokens and user; staff status comes from app_metadata only', async () => {
  const f = fakeClients({ verifyOtp: { data: { session: SESSION, user: SESSION.user } } });
  const r = await new SupabaseAuthApi(f.makeClient, f.admin).verifyCode('ann@acme.test', '123456');
  assert.deepEqual(f.calls[0]!.args, [{ email: 'ann@acme.test', token: '123456', type: 'email' }]);
  assert.ok(r.ok);
  assert.deepEqual(r.tokens, { accessToken: 'at.jwt', refreshToken: 'rt', expiresIn: 1800 });
  assert.deepEqual(r.user, { id: 'u1', email: 'ann@acme.test', isStaff: true });

  // A user who set taxcart_staff in their own editable user_metadata is NOT staff.
  const spoof = { ...SESSION, user: { id: 'u2', email: 'x@y.co', app_metadata: {}, user_metadata: { taxcart_staff: true } } };
  const g = fakeClients({ verifyOtp: { data: { session: spoof } } });
  const s = await new SupabaseAuthApi(g.makeClient, g.admin).verifyCode('x@y.co', '123456');
  assert.ok(s.ok && s.user.isStaff === false);
});

test('verifyCode: wrong code, rate limit, outage and malformed answers are told apart', async () => {
  const cases: [Result | Error, string][] = [
    [{ error: { status: 403, code: 'otp_expired' } }, 'invalid'],
    [{ error: { status: 422 } }, 'invalid'],
    [{ error: { status: 429 } }, 'rate_limited'],
    [{ error: { status: 502 } }, 'unavailable'],
    [new Error('network'), 'unavailable'],
    [{ data: { session: null } }, 'invalid'],
    [{ data: { session: { access_token: 'a' } } }, 'invalid'],
    [{ data: { session: { ...SESSION, user: null }, user: null } }, 'invalid'],
  ];
  for (const [script, expected] of cases) {
    const f = fakeClients({ verifyOtp: script });
    const r = await new SupabaseAuthApi(f.makeClient, f.admin).verifyCode('a@b.co', '123456');
    assert.ok(!r.ok && r.reason === expected, `${JSON.stringify(script)} -> ${expected}`);
  }
});

test('a missing expiry falls back to one hour', async () => {
  const f = fakeClients({ verifyOtp: { data: { session: { ...SESSION, expires_in: undefined } } } });
  const r = await new SupabaseAuthApi(f.makeClient, f.admin).verifyCode('a@b.co', '123456');
  assert.ok(r.ok && r.tokens.expiresIn === 3600);
});

test('refresh and getUser map results the same careful way', async () => {
  const ok = fakeClients({ refreshSession: { data: { session: SESSION } }, getUser: { data: { user: SESSION.user } } });
  const api = new SupabaseAuthApi(ok.makeClient, ok.admin);
  const r = await api.refresh('old-rt');
  assert.deepEqual(ok.calls[0]!.args, [{ refresh_token: 'old-rt' }]);
  assert.ok(r.ok && r.tokens.refreshToken === 'rt');
  const u = await api.getUser('at.jwt');
  assert.deepEqual(ok.calls[1]!.args, ['at.jwt']);
  assert.ok(u.ok && u.user.id === 'u1');

  const bad = fakeClients({ refreshSession: { error: { status: 400 } }, getUser: { error: { status: 401 } } });
  const b = new SupabaseAuthApi(bad.makeClient, bad.admin);
  assert.deepEqual(await b.refresh('x'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await b.getUser('x'), { ok: false, reason: 'invalid' });

  const down = fakeClients({ refreshSession: { error: { status: 500 } }, getUser: new Error('network') });
  const d = new SupabaseAuthApi(down.makeClient, down.admin);
  assert.deepEqual(await d.refresh('x'), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await d.getUser('x'), { ok: false, reason: 'unavailable' });
});

test('every call uses a brand-new client, so one visitor\'s session can never leak into another\'s', async () => {
  const f = fakeClients({ verifyOtp: { data: { session: SESSION } }, getUser: { data: { user: SESSION.user } } });
  const api = new SupabaseAuthApi(f.makeClient, f.admin);
  await api.sendCode('a@b.co');
  await api.verifyCode('a@b.co', '123456');
  await api.refresh('rt');
  await api.getUser('at');
  assert.equal(f.clientsMade(), 4);
});

test('revoke ends only this session at the provider, and never throws', async () => {
  const f = fakeClients();
  await new SupabaseAuthApi(f.makeClient, f.admin).revoke('at.jwt');
  assert.deepEqual(f.calls[0], { method: 'signOut', args: ['at.jwt', 'local'] });

  const broken = fakeClients({}, new Error('down'));
  await new SupabaseAuthApi(broken.makeClient, broken.admin).revoke('at.jwt'); // must not throw
});

// ------------------------------------------------------------------ throttle & audit wrappers

function fakeRpc(result: { data?: unknown; error?: { message: string } | null }) {
  const calls: { fn: string; args: unknown }[] = [];
  const db = { rpc: async (fn: string, args: unknown) => (calls.push({ fn, args }), { data: null, error: null, ...result }) } as unknown as SupabaseClient;
  return { db, calls };
}

test('SupabaseThrottle calls the database functions with a window the database understands', async () => {
  const allowed = fakeRpc({ data: true });
  assert.equal(await new SupabaseThrottle(allowed.db).hit('bucket', 5, 900), true);
  assert.deepEqual(allowed.calls[0], { fn: 'auth_throttle_hit', args: { p_bucket: 'bucket', p_limit: 5, p_window: '900 seconds' } });

  assert.equal(await new SupabaseThrottle(fakeRpc({ data: false }).db).hit('b', 1, 60), false);
  // Anything other than an explicit `true` counts as blocked.
  assert.equal(await new SupabaseThrottle(fakeRpc({ data: null }).db).hit('b', 1, 60), false);

  await assert.rejects(new SupabaseThrottle(fakeRpc({ error: { message: 'db down' } }).db).hit('b', 1, 60), /throttle hit failed/);

  const reset = fakeRpc({});
  await new SupabaseThrottle(reset.db).reset('bucket');
  assert.deepEqual(reset.calls[0], { fn: 'auth_throttle_reset', args: { p_bucket: 'bucket' } });
});

test('SupabaseAuditSink writes the audit_log columns, and reports failure', async () => {
  const inserted: { table: string; row: unknown }[] = [];
  const mk = (error: { message: string } | null) => ({ from: (table: string) => ({ insert: async (row: unknown) => (inserted.push({ table, row }), { error }) }) }) as unknown as SupabaseClient;

  await new SupabaseAuditSink(mk(null)).record({ tenantId: 't1', actorId: 'u1', action: 'document.download', target: 'filing:f1:return', detail: { a: 1 } });
  assert.deepEqual(inserted[0], { table: 'audit_log', row: { tenant_id: 't1', actor_id: 'u1', action: 'document.download', target: 'filing:f1:return', detail: { a: 1 } } });

  await new SupabaseAuditSink(mk(null)).record({ action: 'auth.login' });
  assert.deepEqual(inserted[1]!.row, { tenant_id: null, actor_id: null, action: 'auth.login', target: null, detail: null });

  await assert.rejects(new SupabaseAuditSink(mk({ message: 'nope' })).record({ action: 'x' }), /audit insert failed/);
});
