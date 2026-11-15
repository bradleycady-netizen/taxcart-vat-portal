import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../src/http/authApi.ts';
import { vatRoute } from '../src/http/handlers/vat.ts';
import { LIMITS } from '../src/http/limits.ts';
import { vatDb } from './vatFake.ts';
import { ORIGIN, T_A, T_B, U_A, U_B, USER_A, USER_B, USER_STAFF, body, cookiesFor, get, harness, post } from './httpHelpers.ts';

type Row = Record<string, unknown>;

const U_ACC = 'd4444444-0000-4000-8000-000000000004';
const USER_ACC: AuthUser = { id: U_ACC, email: 'acc@acme.test', isStaff: false };

function setup(extraRegs: Row[] = []) {
  const h = harness();
  h.auth.addUser(USER_ACC);
  const tables: Record<string, Row[]> = {
    tenants: [{ id: T_A, name: 'Acme Skincare' }, { id: T_B, name: 'Beta Foods' }],
    tenant_members: [{ tenant_id: T_A, user_id: U_A, role: 'owner' }, { tenant_id: T_A, user_id: U_ACC, role: 'accountant' }, { tenant_id: T_B, user_id: U_B, role: 'owner' }],
    vat_registrations: [
      { id: 'r1000000-0000-4000-8000-000000000001', tenant_id: T_A, scheme: 'ioss', country: 'PL', frequency: 'monthly', vat_number: null },
      { id: 'r1000000-0000-4000-8000-000000000002', tenant_id: T_A, scheme: 'uk_vat', country: 'GB', frequency: 'quarterly', vat_number: null },
      { id: 'r2000000-0000-4000-8000-000000000001', tenant_id: T_B, scheme: 'oss', country: 'DE', frequency: 'quarterly', vat_number: null },
      ...extraRegs,
    ],
    vat_returns: [],
    vat_events: [],
  };
  const files = new Map<string, Uint8Array>();
  const members = (id: string) => new Set(tables['tenant_members']!.filter((m) => m['user_id'] === id).map((m) => String(m['tenant_id'])));
  h.deps.serviceDb = vatDb(tables, null, files);
  h.deps.userDb = (token) => {
    const u = h.auth.validAccess.get(token);
    return vatDb(tables, u ? (u.isStaff ? null : members(u.id)) : new Set(), files);
  };
  const cookie = (u: AuthUser) => cookiesFor(h.auth.session(u));
  return { h, tables, files, cookie, ann: cookie(USER_A), bob: cookie(USER_B), staff: cookie(USER_STAFF), acc: cookie(USER_ACC) };
}

const CSV = 'Name,Created at,Shipping Country Code,Subtotal,Currency\n#1,2026-09-03,DE,100.50,EUR\n#2,2026-09-09,FR,50,EUR\n';
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

function upload(op: string, params: Record<string, string>, bytes: Uint8Array | string, cookie: string, name = 'orders.csv', origin: string | null = ORIGIN): Request {
  const headers = new Headers({ 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), cookie, 'x-real-ip': '203.0.113.7' });
  if (origin) headers.set('origin', origin);
  return new Request(`https://portal.example.com/api/vat?${q({ op, ...params })}`, { method: 'POST', headers, body: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes });
}
const IOSS = { tenant: T_A, scheme: 'ioss', country: 'PL', period: '2026-09' };

async function submitOk(s: ReturnType<typeof setup>) {
  const res = await vatRoute(upload('submit', IOSS, CSV, s.ann), s.h.deps);
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await body(res)).id as string;
}
const staffPost = (s: ReturnType<typeof setup>, op: string, payload: unknown, cookie = s.staff) => vatRoute(post(`/api/vat?op=${op}`, payload, { cookie }), s.h.deps);

test('an unknown operation is a plain 404, and signed-out callers get 401', async () => {
  const s = setup();
  assert.equal((await vatRoute(get('/api/vat?op=nope', { cookie: s.ann }), s.h.deps)).status, 404);
  assert.equal((await vatRoute(get(`/api/vat?op=list&tenant=${T_A}`), s.h.deps)).status, 401);
});

test('list: a client sees their own registrations with the periods they can upload for, and nothing of other clients', async () => {
  const s = setup();
  const res = await vatRoute(get(`/api/vat?op=list&tenant=${T_A}`, { cookie: s.ann }), s.h.deps);
  assert.equal(res.status, 200);
  const j = await body(res);
  assert.deepEqual(j.registrations.map((r: any) => r.scheme), ['ioss', 'uk_vat']);
  assert.deepEqual(j.registrations[0].periods.map((p: any) => p.code), ['2026-09', '2026-08', '2026-07', '2026-06']);
  assert.deepEqual(j.registrations[1].periods.map((p: any) => p.code), ['2026-Q3', '2026-Q2', '2026-Q1', '2025-Q4']);
  assert.equal(j.registrations[1].periods[0].dueOn, '2026-11-06');
  const other = await body(await vatRoute(get(`/api/vat?op=list&tenant=${T_B}`, { cookie: s.ann }), s.h.deps));
  assert.deepEqual(other.registrations, [], 'another client\'s data is not visible');
});

test('check reports problems without saving anything', async () => {
  const s = setup();
  const ok = await body(await vatRoute(upload('check', IOSS, CSV, s.ann), s.h.deps));
  assert.equal(ok.result.ok, true);
  assert.equal(s.tables['vat_returns']!.length, 0);
  assert.equal(s.files.size, 0);
  const bad = await body(await vatRoute(upload('check', IOSS, 'Order,When\n1,2\n', s.ann), s.h.deps));
  assert.equal(bad.result.ok, false);
  assert.equal(bad.result.errors[0].code, 'columns');
});

test('submit stores the file privately, records the return as Submitted and logs it', async () => {
  const s = setup();
  const id = await submitOk(s);
  const row = s.tables['vat_returns']![0]!;
  assert.equal(row['id'], id);
  assert.equal(row['status'], 'submitted');
  assert.equal(row['due_on'], '2026-10-31');
  assert.equal(row['upload_rows'], 2);
  assert.match(String(row['upload_path']), new RegExp(`^${T_A}/${id}/upload-[0-9a-f]{12}\\.csv$`));
  assert.equal(s.files.size, 1);
  assert.equal(s.tables['vat_events']![0]!['kind'], 'submitted');
  assert.ok(s.h.audit.entries.some((e) => e.action === 'vat.submitted' && e.tenantId === T_A));
});

test('submit refuses a file with errors (422) and saves nothing', async () => {
  const s = setup();
  const res = await vatRoute(upload('submit', IOSS, 'Name,Created at,Shipping Country Code,Subtotal\n#1,2026-09-03,Narnia,10\n', s.ann), s.h.deps);
  assert.equal(res.status, 422);
  assert.equal((await body(res)).result.errors[0].code, 'bad_country');
  assert.equal(s.tables['vat_returns']!.length, 0);
  assert.equal(s.files.size, 0);
});

test('submit again before Taxcart starts replaces the file; after that it is refused', async () => {
  const s = setup();
  const id = await submitOk(s);
  const again = await vatRoute(upload('submit', IOSS, CSV.replace('100.50', '200.50'), s.ann), s.h.deps);
  assert.equal(again.status, 200);
  assert.equal((await body(again)).replaced, true);
  assert.equal(s.tables['vat_returns']!.length, 1);
  assert.equal(s.files.size, 1, 'the old file is removed');
  assert.equal(s.tables['vat_events']!.at(-1)!['kind'], 'file_replaced');
  s.tables['vat_returns']![0]!['status'] = 'received';
  const late = await vatRoute(upload('submit', IOSS, CSV, s.ann), s.h.deps);
  assert.equal(late.status, 409);
  assert.equal((await body(late)).error.code, 'already_received');
  assert.equal(s.tables['vat_returns']![0]!['id'], id);
});

test('uploads are refused for: another client, an unregistered filing, an unfinished period, bad input, a foreign origin and view-only accountants', async () => {
  const s = setup();
  assert.equal((await vatRoute(upload('submit', { ...IOSS, tenant: T_B }, CSV, s.ann), s.h.deps)).status, 404, 'not a member of that client');
  assert.equal((await vatRoute(upload('submit', { ...IOSS, country: 'FR' }, CSV, s.ann), s.h.deps)).status, 400, 'not registered in France');
  assert.equal((await body(await vatRoute(upload('submit', { ...IOSS, period: '2026-10' }, CSV, s.ann), s.h.deps))).error.code, 'period_open');
  assert.equal((await vatRoute(upload('submit', { ...IOSS, period: '2026-Q3' }, CSV, s.ann), s.h.deps)).status, 400, 'a quarter is not a monthly period');
  assert.equal((await vatRoute(upload('submit', { ...IOSS, scheme: 'made_up' }, CSV, s.ann), s.h.deps)).status, 400);
  assert.equal((await vatRoute(upload('submit', IOSS, CSV, s.ann, 'orders.csv', 'https://evil.example'), s.h.deps)).status, 403);
  assert.equal((await vatRoute(upload('submit', IOSS, CSV, s.ann, 'orders.csv', null), s.h.deps)).status, 403);
  const acc = await vatRoute(upload('submit', IOSS, CSV, s.acc), s.h.deps);
  assert.equal(acc.status, 403);
  assert.equal((await body(acc)).error.code, 'read_only');
  assert.equal(s.tables['vat_returns']!.length, 0);
  const wrongType = new Request(`https://portal.example.com/api/vat?${q({ op: 'submit', ...IOSS })}`, { method: 'POST', headers: { origin: ORIGIN, cookie: s.ann, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await vatRoute(wrongType, s.h.deps)).status, 415);
});

test('an oversized file is refused before it is read', async () => {
  const s = setup();
  const res = await vatRoute(upload('submit', IOSS, new Uint8Array(4 * 1024 * 1024 + 5000), s.ann), s.h.deps);
  assert.equal(res.status, 413);
});

test('staff queue and client lists are staff-only (everyone else gets 404)', async () => {
  const s = setup();
  await submitOk(s);
  for (const op of ['queue', 'clients']) {
    assert.equal((await vatRoute(get(`/api/vat?op=${op}`, { cookie: s.ann }), s.h.deps)).status, 404);
  }
  for (const op of ['staff-status', 'staff-ask', 'staff-register', 'staff-unregister', 'staff-client']) {
    assert.equal((await staffPost(s, op, {}, s.ann)).status, 404, op);
  }
  const queue = await body(await vatRoute(get('/api/vat?op=queue', { cookie: s.staff }), s.h.deps));
  assert.equal(queue.returns.length, 1);
  assert.equal(queue.returns[0].tenantName, 'Acme Skincare');
  assert.equal(queue.returns[0].schemeLabel, 'IOSS');
  assert.equal(queue.returns[0].periodLabel, 'Sep 2026');
  const clients = await body(await vatRoute(get('/api/vat?op=clients', { cookie: s.staff }), s.h.deps));
  assert.equal(clients.clients.find((c: any) => c.id === T_A).registrations.length, 2);
  assert.ok(clients.countries.some((c: any) => c.code === 'PL'));
});

test('the full life of a return: questions, replies, return file, statuses and downloads', async () => {
  const s = setup();
  const id = await submitOk(s);

  // staff move it along
  assert.equal((await staffPost(s, 'staff-status', { id, status: 'received' })).status, 200);
  assert.equal((await staffPost(s, 'staff-status', { id, status: 'banana' })).status, 400);
  const early = await staffPost(s, 'staff-status', { id, status: 'filed' });
  assert.equal(early.status, 400);
  assert.equal((await body(early)).error.code, 'return_missing');

  // a question makes it "waiting on client", the client's reply clears that
  assert.equal((await staffPost(s, 'staff-ask', { id, body: 'Is the Swiss order included?' })).status, 201);
  assert.equal(s.tables['vat_returns']![0]!['awaiting_client'], true);
  let d = await body(await vatRoute(get(`/api/vat?op=detail&id=${id}`, { cookie: s.ann }), s.h.deps));
  assert.equal(d.return.awaitingClient, true);
  assert.equal(d.return.returnFile, null);
  const listed = await body(await vatRoute(get(`/api/vat?op=list&tenant=${T_A}`, { cookie: s.ann }), s.h.deps));
  assert.equal(listed.returns[0].question.body, 'Is the Swiss order included?', 'the open question is on the card');
  assert.deepEqual(d.events.map((e: any) => e.kind), ['submitted', 'status', 'question']);
  assert.equal(d.uploadSummary, undefined, 'clients are not sent staff-only detail');
  assert.equal((await vatRoute(post('/api/vat?op=reply', { id, body: 'Yes, it is.' }, { cookie: s.bob }), s.h.deps)).status, 404, 'another client cannot reply');
  assert.equal((await vatRoute(post('/api/vat?op=reply', { id, body: 'Yes, it is.' }, { cookie: s.acc }), s.h.deps)).status, 403, 'view-only accountants cannot reply');
  assert.equal((await vatRoute(post('/api/vat?op=reply', { id, body: 'Yes, it is.' }, { cookie: s.ann }), s.h.deps)).status, 201);
  assert.equal(s.tables['vat_returns']![0]!['awaiting_client'], false);
  assert.equal((await vatRoute(post('/api/vat?op=reply', { id, body: '   ' }, { cookie: s.ann }), s.h.deps)).status, 400);

  // the staff see the upload summary; the client cannot get the return before it is prepared
  d = await body(await vatRoute(get(`/api/vat?op=detail&id=${id}`, { cookie: s.staff }), s.h.deps));
  assert.equal(d.uploadSummary.summary.rows, 2);
  const pdf = new TextEncoder().encode('%PDF-1.4 fake');
  const notPdf = await vatRoute(upload('staff-return', { id }, 'hello', s.staff, 'return.pdf'), s.h.deps);
  assert.equal(notPdf.status, 400);
  assert.equal((await vatRoute(upload('staff-return', { id }, pdf, s.ann, 'return.pdf'), s.h.deps)).status, 404, 'clients cannot attach returns');
  assert.equal((await vatRoute(upload('staff-return', { id }, pdf, s.staff, '../../evil/return'), s.h.deps)).status, 201);
  assert.match(String(s.tables['vat_returns']![0]!['return_name']), /^return\.pdf$/, 'the file name is cleaned of folders');
  assert.equal((await vatRoute(get(`/api/vat?op=download&id=${id}&kind=return`, { cookie: s.ann }), s.h.deps)).status, 404, 'not yet prepared');

  assert.equal((await staffPost(s, 'staff-status', { id, status: 'return_prepared', note: 'Ready for your records' })).status, 200);
  const dl = await body(await vatRoute(get(`/api/vat?op=download&id=${id}&kind=return`, { cookie: s.ann }), s.h.deps));
  assert.match(dl.url, /^https:\/\/files\.test\/.+return-[0-9a-f]{12}\.pdf/);
  assert.equal((await vatRoute(get(`/api/vat?op=download&id=${id}&kind=return`, { cookie: s.bob }), s.h.deps)).status, 404, 'another client cannot download it');
  assert.equal((await vatRoute(get(`/api/vat?op=download&id=${id}&kind=upload`, { cookie: s.ann }), s.h.deps)).status, 200);

  // filed (with a corrected due date), then complete
  const filed = await staffPost(s, 'staff-status', { id, status: 'filed', dueOn: '2026-11-02' });
  assert.equal(filed.status, 200);
  const row = s.tables['vat_returns']![0]!;
  assert.equal(row['status'], 'filed');
  assert.equal(row['due_on'], '2026-11-02');
  assert.ok(row['filed_at']);
  assert.equal((await staffPost(s, 'staff-status', { id, status: 'complete' })).status, 200);
  assert.equal((await staffPost(s, 'staff-status', { id, status: 'complete', dueOn: 'soon' })).status, 400);
  d = await body(await vatRoute(get(`/api/vat?op=detail&id=${id}`, { cookie: s.ann }), s.h.deps));
  assert.deepEqual(d.events.map((e: any) => e.kind), ['submitted', 'status', 'question', 'reply', 'return_attached', 'status', 'status', 'due_changed', 'status']);
  assert.ok(s.h.audit.entries.some((e) => e.action === 'vat.status'));
  assert.ok(s.h.audit.entries.some((e) => e.action === 'vat.download'));
});

test('staff can set up and remove filings for a client, and create a client', async () => {
  const s = setup();
  assert.equal((await staffPost(s, 'staff-register', { tenantId: T_B, scheme: 'ioss', country: 'DE', frequency: 'monthly', vatNumber: 'de123456789' })).status, 201);
  assert.equal(s.tables['vat_registrations']!.at(-1)!['vat_number'], 'DE123456789');
  assert.equal((await staffPost(s, 'staff-register', { tenantId: T_B, scheme: 'ioss', country: 'DE', frequency: 'monthly' })).status, 409);
  assert.equal((await staffPost(s, 'staff-register', { tenantId: T_B, scheme: 'ioss', country: 'GB', frequency: 'monthly' })).status, 400);
  assert.equal((await staffPost(s, 'staff-register', { tenantId: T_B, scheme: 'oss', country: 'FR', frequency: 'monthly' })).status, 400);
  assert.equal((await staffPost(s, 'staff-register', { tenantId: randomUUID(), scheme: 'oss', country: 'FR', frequency: 'quarterly' })).status, 404);
  const id = String(s.tables['vat_registrations']!.at(-1)!['id']);
  assert.equal((await staffPost(s, 'staff-unregister', { id })).status, 200);
  assert.ok(!s.tables['vat_registrations']!.some((r) => r['id'] === id));
  const made = await staffPost(s, 'staff-client', { name: '  New   Client Ltd ', email: 'New.Person@client.test' });
  assert.equal(made.status, 201);
  assert.equal((await body(made)).client.name, 'New Client Ltd');
  assert.deepEqual(s.h.auth.ensured, ['new.person@client.test']);
  assert.equal((await staffPost(s, 'staff-client', { name: 'x' })).status, 400);
});

test('staff actions need an allowed origin; uploads are rate limited', async () => {
  const s = setup();
  const noOrigin = post('/api/vat?op=staff-ask', { id: randomUUID(), body: 'hi' }, { cookie: s.staff, origin: 'https://evil.example' });
  assert.equal((await vatRoute(noOrigin, s.h.deps)).status, 403);
  const rule = LIMITS.vatUpload.perUser;
  let last = 0;
  for (let i = 0; i < rule.limit + 1; i++) last = (await vatRoute(upload('check', IOSS, CSV, s.ann), s.h.deps)).status;
  assert.equal(last, 429);
});

test('staff can preview a client: they see what the client sees, and what they submit is recorded as the client\'s with an audit entry', async () => {
  const s = setup();
  // a return that already has a PDF attached, but is not yet prepared
  const id = await submitOk(s);
  const pdf = new TextEncoder().encode('%PDF-1.4 x');
  assert.equal((await vatRoute(upload('staff-return', { id }, pdf, s.staff, 'r.pdf'), s.h.deps)).status, 201);
  const asStaff = await body(await vatRoute(get(`/api/vat?op=list&tenant=${T_A}`, { cookie: s.staff }), s.h.deps));
  assert.ok(asStaff.returns[0].returnFile, 'staff normally see the attached return');
  const preview = await body(await vatRoute(get(`/api/vat?op=list&tenant=${T_A}&preview=1`, { cookie: s.staff }), s.h.deps));
  assert.equal(preview.returns[0].returnFile, null, 'the preview hides it until it is prepared, as a client would experience');
  const d = await body(await vatRoute(get(`/api/vat?op=detail&id=${id}&preview=1`, { cookie: s.staff }), s.h.deps));
  assert.equal(d.uploadSummary, undefined);
  assert.equal(d.return.tenantName, undefined);

  // a question, answered on the client's behalf
  assert.equal((await staffPost(s, 'staff-ask', { id, body: 'Any non-EU orders?' })).status, 201);
  assert.equal(s.tables['vat_returns']![0]!['awaiting_client'], true);
  assert.equal((await vatRoute(post('/api/vat?op=reply', { id, body: 'No.', behalf: true }, { cookie: s.staff }), s.h.deps)).status, 201);
  assert.equal(s.tables['vat_returns']![0]!['awaiting_client'], false);
  assert.equal(s.tables['vat_events']!.at(-1)!['actor_side'], 'client');
  assert.ok(s.h.audit.entries.some((e) => e.action === 'vat.reply_on_behalf'));

  // submitting on behalf (replacing the file while still Submitted is not possible once received, so use a fresh period)
  const res = await vatRoute(upload('submit', { ...IOSS, period: '2026-08', behalf: '1' }, CSV.replaceAll('2026-09', '2026-08'), s.staff), s.h.deps);
  assert.equal(res.status, 201);
  assert.equal(s.tables['vat_events']!.at(-1)!['actor_side'], 'client');
  assert.ok(s.h.audit.entries.some((e) => e.action === 'vat.submitted' && (e.detail as any)?.onBehalfOfClient === true));
  // without the flag a staff upload is recorded as staff
  const res2 = await vatRoute(upload('submit', { ...IOSS, period: '2026-07' }, CSV.replaceAll('2026-09', '2026-07'), s.staff), s.h.deps);
  assert.equal(res2.status, 201);
  assert.equal(s.tables['vat_events']!.at(-1)!['actor_side'], 'staff');
  // the flag means nothing to a client
  const sneaky = await vatRoute(post('/api/vat?op=reply', { id, body: 'hi', behalf: true }, { cookie: s.ann }), s.h.deps);
  assert.equal(sneaky.status, 201);
  assert.ok(!s.h.audit.entries.some((e) => e.action === 'vat.reply_on_behalf' && e.actorId === U_A));
});

test('welcome email: off by default, sent when switched on, never undoes the client, and resend needs real access', async () => {
  const s = setup();
  const sent: any[] = [];
  const staffCreate = (email: string, name: string) => vatRoute(post('/api/vat?op=staff-client', { name, email }, { cookie: s.staff }), s.h.deps);
  // switched off: client created, nothing sent
  let r = await staffCreate('new1@client.test', 'First Client');
  assert.equal(r.status, 201);
  assert.equal((await body(r)).emailed, 'off');
  // switched on
  s.h.deps.mailer = { send: async (m) => { sent.push(m); return true; } };
  s.h.deps.portalUrl = 'https://portal.example.com/vat/';
  r = await staffCreate('new2@client.test', 'Second <b>Client</b>');
  assert.equal(r.status, 201);
  assert.equal((await body(r)).emailed, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'new2@client.test');
  assert.ok(sent[0].text.includes('https://portal.example.com/vat/'));
  assert.ok(!sent[0].html.includes('<b>Client</b>'), 'the client name is escaped in the HTML');
  assert.ok(!/zamp|taxually/i.test(sent[0].text + sent[0].html), 'no vendor names');
  // a failing mail provider does not undo the client
  s.h.deps.mailer = { send: async () => false };
  r = await staffCreate('new3@client.test', 'Third Client');
  assert.equal(r.status, 201);
  assert.equal((await body(r)).emailed, 'failed');
  assert.ok(s.tables['tenants']!.some((t) => t['name'] === 'Third Client'));
  // resend: only staff, only for someone who has access
  s.h.deps.mailer = { send: async (m) => { sent.push(m); return true; } };
  const tenantId = String(s.tables['tenants']!.find((t) => t['name'] === 'Second <b>Client</b>')!['id']);
  assert.equal((await vatRoute(post('/api/vat?op=staff-invite', { tenantId, email: 'new2@client.test' }, { cookie: s.staff }), s.h.deps)).status, 200);
  assert.equal(sent.length, 2);
  assert.equal((await vatRoute(post('/api/vat?op=staff-invite', { tenantId, email: 'stranger@client.test' }, { cookie: s.staff }), s.h.deps)).status, 404);
  assert.equal((await vatRoute(post('/api/vat?op=staff-invite', { tenantId, email: 'new2@client.test' }, { cookie: s.ann }), s.h.deps)).status, 404);
  assert.equal(sent.length, 2);
});

test('nil return: a client can confirm no sales, it appears as Submitted for staff, and it cannot overwrite an existing return', async () => {
  const s = setup();
  const nilReq = (period: string, cookie: string, extra: Record<string, string> = {}) =>
    vatRoute(post(`/api/vat?${q({ op: 'submit-nil', ...IOSS, period, ...extra })}`, {}, { cookie }), s.h.deps);
  const res = await nilReq('2026-08', s.ann);
  assert.equal(res.status, 201);
  const id = (await body(res)).id;
  const row = s.tables['vat_returns']!.find((r) => r['id'] === id)!;
  assert.equal(row['status'], 'submitted');
  assert.equal(row['upload_path'], null);
  assert.equal(s.tables['vat_events']!.at(-1)!['body'], 'No sales this period');
  assert.ok(s.h.audit.entries.some((e) => e.action === 'vat.nil_submitted'));
  // staff and the client both see it flagged as nil, with no sales file to download
  const staffList = await body(await vatRoute(get(`/api/vat?op=queue`, { cookie: s.staff }), s.h.deps));
  const item = (staffList.returns as any[]).find((r) => r.id === id);
  assert.equal(item.nil, true);
  assert.equal(item.upload, null);
  // a second attempt for the same period is refused, and so is a nil return over an uploaded file
  assert.equal((await nilReq('2026-08', s.ann)).status, 409);
  await submitOk(s);
  assert.equal((await nilReq('2026-09', s.ann)).status, 409);
  // the view-only accountant cannot send one; an open period is refused; another client's id is not reachable
  assert.equal((await nilReq('2026-07', s.acc)).status, 403);
  assert.equal((await nilReq('2099-01', s.ann)).status, 400);
  assert.ok([403, 404].includes((await nilReq('2026-07', s.bob)).status), 'a person from another client is refused');
  assert.equal(s.tables['vat_returns']!.filter((r) => r['period_code'] === '2026-07').length, 0);
});

test('staff alerts go to the shared inbox when a client uploads, sends a nil return or replies; off by default; never block the request', async () => {
  const s = setup();
  const sent: any[] = [];
  // off: nothing sent, everything works
  await submitOk(s);
  assert.equal(sent.length, 0);
  s.h.deps.mailer = { send: async (m) => { sent.push(m); return true; } };
  s.h.deps.portalUrl = 'https://portal.example.com/vat/';
  s.h.deps.alertTo = 'consulting@taxcart.com.au';
  const nil = await vatRoute(post(`/api/vat?${q({ op: 'submit-nil', ...IOSS, period: '2026-08' })}`, {}, { cookie: s.ann }), s.h.deps);
  assert.equal(nil.status, 201);
  const retId = String(s.tables['vat_returns']![0]!['id']);
  assert.equal((await vatRoute(post('/api/vat?op=reply', { id: retId, body: 'Hello' }, { cookie: s.ann }), s.h.deps)).status, 201);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((m) => m.to === 'consulting@taxcart.com.au'));
  assert.ok(sent[0].subject.includes('Acme Skincare') && /no sales/.test(sent[0].text));
  assert.ok(!/Acme.*@|zamp|taxually/i.test(sent[1].text), 'no personal details or vendor names');
  // staff actions (including "view as client") do not alert the shared inbox
  assert.equal((await vatRoute(post('/api/vat?op=reply', { id: retId, body: 'Staff note', behalf: true }, { cookie: s.staff }), s.h.deps)).status, 201);
  assert.equal(sent.length, 2);
  // a failing mail provider never breaks the upload
  s.h.deps.mailer = { send: async () => { throw new Error('down'); } };
  const res = await vatRoute(upload('submit', { ...IOSS, period: '2026-07' }, CSV.replaceAll('2026-09', '2026-07'), s.ann), s.h.deps);
  assert.equal(res.status, 201);
});
