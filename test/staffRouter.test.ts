import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staffRoute } from '../src/http/handlers/staffRouter.ts';
import { InMemoryStore } from './helpers.ts';
import { T_A, USER_A, USER_STAFF, body, cookiesFor, get, harness, post } from './httpHelpers.ts';

const staffDeps = () => ({ store: new InMemoryStore(), source: { getActive: async () => null } });

test('one staff function serves every staff action, chosen by ?op=', async () => {
  const h = harness();
  const cookie = cookiesFor(h.auth.session(USER_STAFF));
  const sd = staffDeps();
  assert.equal((await staffRoute(get('/api/staff?op=clients', { cookie }), h.deps, sd)).status, 200);
  assert.equal((await staffRoute(get(`/api/staff?op=users&tenant=${T_A}`, { cookie }), h.deps, sd)).status, 200);
  assert.equal((await staffRoute(post('/api/staff?op=add-user', { tenantId: T_A, email: 'q@r.test', role: 'accountant' }, { cookie }), h.deps, sd)).status, 201);
  assert.equal((await staffRoute(post('/api/staff?op=sync', { connectionId: 'c0000000-0000-4000-8000-0000000000bb' }, { cookie }), h.deps, sd)).status, 404);
  assert.equal((await staffRoute(post('/api/staff?op=logo', { tenantId: T_A, remove: true }, { cookie }), h.deps, sd)).status, 200);
  assert.equal((await staffRoute(post('/api/staff?op=remove-user', { tenantId: T_A, userId: 'c3333333-0000-4000-8000-000000000003' }, { cookie }), h.deps, sd)).status, 200);
});

test('unknown or missing operations, and the wrong method, are a plain 404; clients are refused whatever they ask for', async () => {
  const h = harness();
  const staffCookie = cookiesFor(h.auth.session(USER_STAFF));
  const clientCookie = cookiesFor(h.auth.session(USER_A));
  const sd = staffDeps();
  for (const [req, label] of [
    [get('/api/staff', { cookie: staffCookie }), 'no op'],
    [get('/api/staff?op=nonsense', { cookie: staffCookie }), 'unknown op'],
    [get('/api/staff?op=create-client', { cookie: staffCookie }), 'POST op used with GET'],
    [post('/api/staff?op=clients', {}, { cookie: staffCookie }), 'GET op used with POST'],
  ] as const) {
    const res = await staffRoute(req, h.deps, sd);
    assert.equal(res.status, 404, label);
    assert.equal((await body(res))['error'].code, 'not_found');
  }
  assert.equal((await staffRoute(get('/api/staff?op=clients', { cookie: clientCookie }), h.deps, sd)).status, 404);
  assert.equal((await staffRoute(post('/api/staff?op=add-user', { tenantId: T_A, email: 'x@y.test', role: 'member' }, { cookie: clientCookie }), h.deps, sd)).status, 404);
  assert.equal(h.serviceDb.writes.length, 0);
});
