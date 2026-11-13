import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportFilings } from '../src/http/handlers/data.ts';
import { getLogo, sniffImageType, MAX_LOGO_BYTES } from '../src/http/handlers/logo.ts';
import { addUser, listUsers, removeUser, setLogo } from '../src/http/handlers/staff.ts';
import { getSession } from '../src/http/handlers/auth.ts';
import { LIMITS } from '../src/http/limits.ts';
import { T_A, T_B, U_A, USER_A, USER_B, USER_STAFF, body, cookiesFor, defaultTables, get, harness, post, type Harness } from './httpHelpers.ts';

const asA = (h: Harness) => cookiesFor(h.auth.session(USER_A));
const asStaff = (h: Harness) => cookiesFor(h.auth.session(USER_STAFF));
const exportUrl = (tenant: string, product = 'us_sales_tax') => `/api/filings?format=csv&tenant=${tenant}&product=${product}`;

// 1x1 PNG, 1x1 JPEG header-ish, WebP header
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

// ------------------------------------------------------------------ export

test('the export is a CSV of the filings this person can see: right columns, readable status, no provider detail', async () => {
  const h = harness();
  const res = await exportFilings(get(exportUrl(T_A), { cookie: asA(h) }), h.deps);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /^text\/csv/);
  assert.match(res.headers.get('content-disposition')!, /attachment; filename="filings-us_sales_tax-2026-10-22\.csv"/);
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8'); // (Response.text() would hide the byte-order mark)
  assert.ok(text.startsWith('﻿"Jurisdiction","Period","Frequency","Due date","Status","Estimated tax (USD)","Amount paid (USD)","Return confirmation","Payment confirmation"\r\n'));
  assert.match(text, /"KS","January 2025","Monthly","2025-02-25","Filed","25.25","25.25","RET-1","PAY-1"/);
  assert.match(text, /"KS","February 2025","Monthly","2025-03-25","Past due date","31.10","","",""/);
  assert.match(text, /"TX","Q4 2024","Quarterly"/, 'history from an earlier provider is included');
  for (const hidden of ['vendor', 'connection', 'BETA-RET', 'tenant_id']) assert.ok(!text.includes(hidden), `leaks "${hidden}"`);
  assert.equal(h.audit.entries.at(-1)!.action, 'filings.export');
});

test("someone else's client cannot be exported, and looks like one that does not exist", async () => {
  const h = harness();
  assert.equal((await exportFilings(get(exportUrl(T_B), { cookie: asA(h) }), h.deps)).status, 404);
  assert.equal((await exportFilings(get(exportUrl(T_A)), h.deps)).status, 401);
  assert.equal(h.audit.entries.length, 0);
});

test('spreadsheet formulas in the data cannot run when the file is opened', async () => {
  const tables = defaultTables();
  (tables['filings'] as any[])[0].return_confirmation = '=HYPERLINK("http://evil","x")';
  (tables['filings'] as any[])[0].period_name = '@SUM(A1)';
  const h = harness({ tables });
  const text = await (await exportFilings(get(exportUrl(T_A), { cookie: asA(h) }), h.deps)).text();
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`));
  assert.ok(text.includes(`"'@SUM(A1)"`));
  assert.ok(!/,"=HYPERLINK/.test(text));
});

test('exports are rate limited like downloads, and an unrecordable export is refused', async () => {
  const h = harness();
  h.audit.failing = true;
  assert.equal((await exportFilings(get(exportUrl(T_A), { cookie: asA(h) }), h.deps)).status, 503);
  h.audit.failing = false;
  const cookie = asA(h);
  for (let i = 0; i < LIMITS.download.perUser.limit; i++) await exportFilings(get(exportUrl(T_A), { cookie }), h.deps);
  assert.equal((await exportFilings(get(exportUrl(T_A), { cookie }), h.deps)).status, 429);
});

// ------------------------------------------------------------------ logos

test('image types are judged by their real contents, and SVG is never accepted', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(JPEG.length > 12 ? JPEG : Buffer.concat([JPEG, Buffer.alloc(20)])), 'image/jpeg');
  assert.equal(sniffImageType(WEBP), 'image/webp');
  assert.equal(sniffImageType(SVG), null);
  assert.equal(sniffImageType(Buffer.from('<html>')), null);
  assert.equal(sniffImageType(new Uint8Array(0)), null);
});

test('staff can set a logo; the client sees it (and only their own), with safe headers', async () => {
  const h = harness();
  const set = await setLogo(post('/api/staff/logo', { tenantId: T_A, data: PNG.toString('base64') }, { cookie: asStaff(h) }), h.deps);
  assert.equal(set.status, 200);
  assert.deepEqual(await body(set), { ok: true, hasLogo: true });

  const own = await getLogo(get(`/api/logo?tenant=${T_A}`, { cookie: asA(h) }), h.deps);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/png');
  assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
  assert.match(own.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), PNG);

  assert.equal((await getLogo(get(`/api/logo?tenant=${T_B}`, { cookie: asA(h) }), h.deps)).status, 404, "another client's logo is not visible");
  assert.equal((await getLogo(get(`/api/logo?tenant=${T_A}`), h.deps)).status, 401);
  assert.equal((await getLogo(get(`/api/logo?tenant=nope`, { cookie: asA(h) }), h.deps)).status, 400);
});

test('the session tells the portal which clients have a logo', async () => {
  const h = harness();
  await setLogo(post('/api/staff/logo', { tenantId: T_A, data: PNG.toString('base64') }, { cookie: asStaff(h) }), h.deps);
  const data = await body(await getSession(get('/api/session', { cookie: asA(h) }), h.deps));
  assert.equal(data['tenants'][0].hasLogo, true);
  const b = await body(await getSession(get('/api/session', { cookie: cookiesFor(h.auth.session(USER_B)) }), h.deps));
  assert.equal(b['tenants'][0].hasLogo, false);
});

test('bad logos are refused and nothing is saved: SVG, wrong bytes, too big, not base64, clients, wrong origin', async () => {
  const h = harness();
  const cookie = asStaff(h);
  const tryIt = async (payload: unknown, opts: Parameters<typeof post>[2] = { cookie }) => (await setLogo(post('/api/staff/logo', payload, opts), h.deps)).status;
  assert.equal(await tryIt({ tenantId: T_A, data: SVG.toString('base64') }), 400);
  assert.equal(await tryIt({ tenantId: T_A, data: Buffer.from('just text, not an image at all').toString('base64') }), 400);
  assert.equal(await tryIt({ tenantId: T_A, data: Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]).toString('base64') }), 400);
  assert.equal(await tryIt({ tenantId: T_A, data: 'not base64 !!' }), 400);
  assert.equal(await tryIt({ tenantId: 'nope', data: PNG.toString('base64') }), 400);
  assert.equal(await tryIt({ tenantId: 'dddddddd-0000-4000-8000-00000000000d', data: PNG.toString('base64') }), 404);
  assert.equal(await tryIt({ tenantId: T_A, data: PNG.toString('base64') }, { cookie: asA(h) }), 404, 'clients cannot upload');
  assert.equal(await tryIt({ tenantId: T_A, data: PNG.toString('base64') }, { cookie, origin: 'https://evil.example' }), 403);
  assert.equal(h.serviceDb.writes.filter((w) => w.table === 'tenant_logos').length, 0);
});

test('a new logo replaces the old one, and staff can remove it', async () => {
  const h = harness();
  const cookie = asStaff(h);
  await setLogo(post('/api/staff/logo', { tenantId: T_A, data: PNG.toString('base64') }, { cookie }), h.deps);
  await setLogo(post('/api/staff/logo', { tenantId: T_A, data: WEBP.toString('base64') }, { cookie }), h.deps);
  assert.equal((await getLogo(get(`/api/logo?tenant=${T_A}`, { cookie: asA(h) }), h.deps)).headers.get('content-type'), 'image/webp');
  const gone = await setLogo(post('/api/staff/logo', { tenantId: T_A, remove: true }, { cookie }), h.deps);
  assert.deepEqual(await body(gone), { ok: true, hasLogo: false });
  assert.equal((await getLogo(get(`/api/logo?tenant=${T_A}`, { cookie: asA(h) }), h.deps)).status, 404);
});

// ------------------------------------------------------------------ staff users

test('staff can list who has access to a client, with roles', async () => {
  const h = harness();
  const res = await listUsers(get(`/api/staff/users?tenant=${T_A}`, { cookie: asStaff(h) }), h.deps);
  assert.deepEqual((await body(res))['users'], [{ userId: U_A, email: 'ann@acme.test', role: 'member' }]);
  assert.equal((await listUsers(get(`/api/staff/users?tenant=${T_A}`, { cookie: asA(h) }), h.deps)).status, 404);
  assert.equal((await listUsers(get(`/api/staff/users?tenant=bad`, { cookie: asStaff(h) }), h.deps)).status, 400);
});

test('adding a person creates their invite-only sign-in if needed, links them with the chosen role, and is audited', async () => {
  const h = harness();
  const cookie = asStaff(h);
  const res = await addUser(post('/api/staff/users', { tenantId: T_A, email: 'Zed@Accountants.test', role: 'accountant' }, { cookie }), h.deps);
  assert.equal(res.status, 201);
  assert.deepEqual(await body(res), { ok: true, newSignIn: true });
  assert.deepEqual(h.auth.ensured, ['zed@accountants.test']);
  const row = h.serviceDb.writes.find((w) => w.table === 'tenant_members')!.rows[0]!;
  assert.equal(row['role'], 'accountant');
  assert.equal(row['tenant_id'], T_A);
  assert.equal(h.audit.entries.at(-1)!.action, 'staff.user_added');

  const dup = await addUser(post('/api/staff/users', { tenantId: T_A, email: USER_A.email, role: 'member' }, { cookie }), h.deps);
  assert.equal(dup.status, 409);
});

test('adding a person rejects bad roles, bad emails, unknown clients, and non-staff', async () => {
  const h = harness();
  const cookie = asStaff(h);
  const call = async (payload: unknown, c = cookie) => (await addUser(post('/api/staff/users', payload, { cookie: c }), h.deps)).status;
  assert.equal(await call({ tenantId: T_A, email: 'a@b.test', role: 'admin' }), 400);
  assert.equal(await call({ tenantId: T_A, email: 'nope', role: 'member' }), 400);
  assert.equal(await call({ tenantId: 'dddddddd-0000-4000-8000-00000000000d', email: 'a@b.test', role: 'member' }), 404);
  assert.equal(await call({ tenantId: T_A, email: 'a@b.test', role: 'member' }, asA(h)), 404);
  h.auth.ensureFails = true;
  assert.equal(await call({ tenantId: T_A, email: 'a@b.test', role: 'member' }), 502);
  assert.equal(h.serviceDb.writes.filter((w) => w.table === 'tenant_members').length, 0);
});

test('removing a person ends their access to that client only', async () => {
  const h = harness();
  const res = await removeUser(post('/api/staff/users/remove', { tenantId: T_A, userId: U_A }, { cookie: asStaff(h) }), h.deps);
  assert.equal(res.status, 200);
  const gone = h.serviceDb.writes.find((w) => w.op === 'delete' && w.table === 'tenant_members')!;
  assert.deepEqual(gone.rows.map((r) => [r['tenant_id'], r['user_id']]), [[T_A, U_A]]);
  assert.equal(h.audit.entries.at(-1)!.action, 'staff.user_removed');
  assert.equal((await removeUser(post('/api/staff/users/remove', { tenantId: T_A, userId: U_A }, { cookie: asA(h) }), h.deps)).status, 404);
  assert.equal((await removeUser(post('/api/staff/users/remove', { tenantId: 'x', userId: U_A }, { cookie: asStaff(h) }), h.deps)).status, 400);
});
