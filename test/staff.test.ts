import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ProviderError } from '../src/core/errors.ts';
import { decryptSecret } from '../src/core/secretbox.ts';
import { MockAdapter } from '../src/providers/mock/adapter.ts';
import { createClient, listClients, syncNow, type StaffDeps } from '../src/http/handlers/staff.ts';
import { LIMITS } from '../src/http/limits.ts';
import { C_A_US, T_A, USER_A, USER_STAFF, body, cookiesFor, get, harness, post, type Harness } from './httpHelpers.ts';
import { InMemoryStore, canonFiling, canonRegistration } from './helpers.ts';

const KEY = randomBytes(32).toString('base64');
const TOKEN = 'zamp-secret-token-1234567890';

function setup() {
  const h = harness();
  h.deps.credentialKey = KEY;
  const store = new InMemoryStore();
  const connections = new Map<string, any>();
  const staff: StaffDeps = { store, source: { getActive: async (id) => connections.get(id) ?? null } };

  // The "zamp" provider is replaced by a mock so no network is touched. It checks the token it is handed.
  let acceptToken = TOKEN;
  const mock = new MockAdapter({
    key: 'zamp',
    registrations: [canonRegistration({ jurisdiction: 'IL' })],
    filings: [canonFiling({ externalId: 'IL:2026-OCT', jurisdiction: 'IL' })],
  });
  const original = h.deps.resolveAdapter;
  h.deps.resolveAdapter = (c) => {
    if (c.providerKey !== 'zamp') return original(c);
    if (c.credentialEnc && decryptSecret(c.credentialEnc, KEY) !== acceptToken) {
      return Object.assign(Object.create(mock), {
        healthCheck: async () => { throw new ProviderError('auth', 'zamp', 'bad token', { status: 401 }); },
      });
    }
    return mock;
  };
  return { h, store, staff, connections, mock, rejectToken: () => (acceptToken = 'something-else') };
}

const staffCookie = (h: Harness) => cookiesFor(h.auth.session(USER_STAFF));
const clientCookie = (h: Harness) => cookiesFor(h.auth.session(USER_A));
const good = { name: 'Brightside Goods', product: 'us_sales_tax', provider: 'zamp', token: TOKEN, email: 'owner@brightside.test' };

// ------------------------------------------------------------------ who may use these endpoints

test('clients (and signed-out visitors) get the same plain 404 as an address that does not exist', async () => {
  const { h, staff } = setup();
  const res = await createClient(post('/api/staff/clients', good, { cookie: clientCookie(h) }), h.deps, staff);
  assert.equal(res.status, 404);
  const list = await listClients(get('/api/staff/clients', { cookie: clientCookie(h) }), h.deps);
  assert.equal(list.status, 404);
  assert.equal((await createClient(post('/api/staff/clients', good), h.deps, staff)).status, 401);
  assert.equal(h.serviceDb.writes.length, 0, 'nothing may be written');
});

test('creating needs the portal\'s own origin and a JSON body', async () => {
  const { h, staff } = setup();
  const cookie = staffCookie(h);
  assert.equal((await createClient(post('/api/staff/clients', good, { cookie, origin: 'https://evil.example' }), h.deps, staff)).status, 403);
  assert.equal((await createClient(post('/api/staff/clients', good, { cookie, origin: null }), h.deps, staff)).status, 403);
  assert.equal((await createClient(post('/api/staff/clients', good, { cookie, contentType: 'text/plain' }), h.deps, staff)).status, 415);
  assert.equal((await createClient(get('/api/staff/clients', { cookie }), h.deps, staff)).status, 405);
});

// ------------------------------------------------------------------ adding a client

test('adding a client saves it, stores the token ENCRYPTED, links the first user as owner, audits it, and refreshes the data', async () => {
  const { h, staff, store } = setup();
  const res = await createClient(post('/api/staff/clients', good, { cookie: staffCookie(h) }), h.deps, staff);
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const data = JSON.parse(text);
  assert.equal(data.client.name, 'Brightside Goods');
  assert.equal(data.invite, 'created');
  assert.equal(data.sync.status, 'succeeded');
  assert.equal(data.sync.registrations, 1);
  assert.equal(data.sync.filings, 1);
  assert.ok(!text.includes(TOKEN), 'the token must never be echoed back');

  const writes = h.serviceDb.writes;
  const conn = writes.find((w) => w.table === 'provider_connections')!.rows[0]!;
  assert.equal(conn['provider_key'], 'zamp');
  assert.equal(conn['status'], 'active');
  assert.equal(conn['credential_ref'], undefined, 'no environment variable is involved');
  assert.ok(String(conn['credential_enc']).startsWith('v1.'));
  assert.ok(!JSON.stringify(writes).includes(TOKEN), 'the token is not written anywhere in plain text');
  assert.equal(decryptSecret(String(conn['credential_enc']), KEY), TOKEN);

  const member = writes.find((w) => w.table === 'tenant_members')!.rows[0]!;
  assert.equal(member['role'], 'owner');
  assert.equal(member['tenant_id'], data.client.id);
  assert.deepEqual(h.auth.ensured, ['owner@brightside.test']);

  assert.equal(h.audit.entries.length, 1);
  assert.equal(h.audit.entries[0]!.action, 'staff.client_created');
  assert.equal(h.audit.entries[0]!.actorId, USER_STAFF.id);
  assert.ok(!JSON.stringify(h.audit.entries).includes(TOKEN));
  assert.ok(!JSON.stringify(h.logs).includes(TOKEN));
  assert.equal(store.registrations.size, 1);
});

test('the first user is optional', async () => {
  const { h, staff } = setup();
  const { email: _omit, ...noEmail } = good;
  const res = await createClient(post('/api/staff/clients', noEmail, { cookie: staffCookie(h) }), h.deps, staff);
  assert.equal(res.status, 201);
  assert.equal((await body(res))['invite'], null);
  assert.equal(h.auth.ensured.length, 0);
});

test('an existing sign-in is reused, and a failed invite does not undo the client', async () => {
  const { h, staff } = setup();
  const existing = await createClient(post('/api/staff/clients', { ...good, email: USER_A.email }, { cookie: staffCookie(h) }), h.deps, staff);
  assert.equal((await body(existing))['invite'], 'existing');

  h.auth.ensureFails = true;
  const res = await createClient(post('/api/staff/clients', { ...good, name: 'Second Co', email: 'x@y.test' }, { cookie: staffCookie(h) }), h.deps, staff);
  assert.equal(res.status, 201);
  assert.equal((await body(res))['invite'], 'failed');
  assert.equal(h.serviceDb.writes.filter((w) => w.table === 'tenants' && w.op === 'insert').length, 2);
});

test('a token the provider rejects saves NOTHING', async () => {
  const { h, staff, rejectToken } = setup();
  rejectToken();
  const res = await createClient(post('/api/staff/clients', good, { cookie: staffCookie(h) }), h.deps, staff);
  assert.equal(res.status, 400);
  assert.equal((await body(res))['error'].code, 'token_rejected');
  assert.equal(h.serviceDb.writes.length, 0);
  assert.equal(h.audit.entries.length, 0);
});

test('if saving the connection fails, the half-made client is removed again', async () => {
  const { h, staff } = setup();
  h.serviceDb.failNextInsert('provider_connections');
  const res = await createClient(post('/api/staff/clients', good, { cookie: staffCookie(h) }), h.deps, staff);
  assert.equal(res.status, 500);
  const made = h.serviceDb.writes.find((w) => w.table === 'tenants' && w.op === 'insert')!;
  const removed = h.serviceDb.writes.find((w) => w.table === 'tenants' && w.op === 'delete')!;
  assert.deepEqual(removed.rows.map((r) => r['id']), [made.rows[0]!['id']]);
});

test('a refresh that fails right after creating still leaves the client in place, reporting the problem', async () => {
  const { h, staff, mock } = setup();
  // The token check passes, then the data fetch fails.
  mock.listRegistrations = async () => { throw new ProviderError('upstream', 'zamp', 'down', { status: 503 }); };
  const res = await createClient(post('/api/staff/clients', good, { cookie: staffCookie(h) }), h.deps, staff);
  assert.equal(res.status, 201);
  assert.equal((await body(res))['sync'].status, 'failed');
});

test('without an encryption key the server says so plainly and saves nothing', async () => {
  const { h, staff } = setup();
  h.deps.credentialKey = undefined;
  const res = await createClient(post('/api/staff/clients', good, { cookie: staffCookie(h) }), h.deps, staff);
  assert.equal(res.status, 503);
  assert.equal((await body(res))['error'].code, 'encryption_not_configured');
  assert.equal(h.serviceDb.writes.length, 0);
});

test('bad input is turned away before anything else happens', async () => {
  const { h, staff } = setup();
  const cookie = staffCookie(h);
  const cases: [string, Record<string, unknown>][] = [
    ['name too short', { ...good, name: 'A' }],
    ['no service', { ...good, product: 'nope' }],
    ['unknown provider', { ...good, provider: 'mystery' }],
    ['token with spaces', { ...good, token: 'has some spaces in it' }],
    ['token too short', { ...good, token: 'abc' }],
    ['bad email', { ...good, email: 'not-an-email' }],
    ['bad company id', { ...good, providerCompanyId: 'a b; drop table' }],
  ];
  for (const [label, payload] of cases) {
    const res = await createClient(post('/api/staff/clients', payload, { cookie }), h.deps, staff);
    assert.equal(res.status, 400, label);
  }
  assert.equal(h.serviceDb.writes.length, 0);
});

test('too many changes in an hour are slowed down', async () => {
  const { h, staff } = setup();
  const cookie = staffCookie(h);
  for (let i = 0; i < LIMITS.staffWrite.perUser.limit; i++) {
    await createClient(post('/api/staff/clients', { ...good, name: 'x' }, { cookie }), h.deps, staff); // each is a 400, but still counts
  }
  const res = await createClient(post('/api/staff/clients', good, { cookie }), h.deps, staff);
  assert.equal(res.status, 429);
});

// ------------------------------------------------------------------ listing and refreshing

test('the client list shows connections and their health, but no tokens, credential names or company IDs', async () => {
  const { h } = setup();
  const res = await listClients(get('/api/staff/clients', { cookie: staffCookie(h) }), h.deps);
  assert.equal(res.status, 200);
  const text = await res.text();
  const data = JSON.parse(text);
  assert.deepEqual(data.providers, [{ key: 'zamp', label: 'Zamp' }]);
  const acme = data.clients.find((c: any) => c.id === T_A);
  assert.equal(acme.users, 1);
  assert.ok(acme.connections.some((c: any) => c.id === C_A_US && c.provider === 'vendor-x'));
  for (const hidden of ['credential', 'VENDOR_X_KEY', 'company-A', 'token']) assert.ok(!text.includes(hidden), `leaks "${hidden}"`);
  for (const sel of h.serviceDb.selections) assert.ok(!/credential/.test(sel.columns), `must not select credential columns: ${sel.columns}`);
});

test('"sync now" refreshes one client and reports the result; unknown or invalid ids are refused', async () => {
  const { h, staff, connections, store } = setup();
  const id = 'c0000000-0000-4000-8000-0000000000aa';
  connections.set(id, { id, tenantId: T_A, product: 'us_sales_tax', providerKey: 'zamp', providerCompanyId: null, credentialRef: 'X', credentialEnc: null, status: 'active' });
  const cookie = staffCookie(h);

  const ok = await syncNow(post('/api/staff/sync', { connectionId: id }, { cookie }), h.deps, staff);
  assert.equal(ok.status, 200);
  assert.equal((await body(ok))['sync'].status, 'succeeded');
  assert.equal(store.registrations.size, 1);

  assert.equal((await syncNow(post('/api/staff/sync', { connectionId: 'c0000000-0000-4000-8000-0000000000bb' }, { cookie }), h.deps, staff)).status, 404);
  assert.equal((await syncNow(post('/api/staff/sync', { connectionId: 'nope' }, { cookie }), h.deps, staff)).status, 400);
  assert.equal((await syncNow(post('/api/staff/sync', { connectionId: id }, { cookie: clientCookie(h) }), h.deps, staff)).status, 404);
});

