import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../src/core/errors.ts';
import { MockAdapter } from '../src/providers/mock/adapter.ts';
import { canonFiling } from './helpers.ts';
import { downloadDocument, listFilings, listRegistrations } from '../src/http/handlers/data.ts';
import { LIMITS } from '../src/http/limits.ts';
import {
  C_A_OLD, F_A_FEB, F_A_JAN, F_A_OLD, F_B_JAN, T_A, T_B, USER_A, USER_B, USER_STAFF,
  body, cookiesFor, get, harness, type Harness,
} from './httpHelpers.ts';

const signedIn = (h: Harness, user = USER_A) => cookiesFor(h.auth.session(user));
const filingsUrl = (tenant: string, product = 'us_sales_tax', extra = '') => `/api/filings?tenant=${tenant}&product=${product}${extra}`;
const docUrl = (filing: string, kind = 'return') => `/api/documents?filing=${filing}&kind=${kind}`;

// ------------------------------------------------------------------ filings & registrations

test('filings come back newest-due first, in the portal\'s own shape, with download links but no internals', async () => {
  const h = harness();
  const res = await listFilings(get(filingsUrl(T_A), { cookie: signedIn(h) }), h.deps);
  assert.equal(res.status, 200);
  const text = await res.text();
  const data = JSON.parse(text);

  assert.deepEqual(data.filings.map((f: any) => f.id), [F_A_FEB, F_A_JAN, F_A_OLD], 'newest due date first, history from the earlier provider included');
  assert.deepEqual(data.filings[1], {
    id: F_A_JAN, jurisdiction: 'KS', periodCode: '2025-JAN', periodName: 'January 2025', frequency: 'monthly',
    dueOn: '2025-02-25', isCompleted: true, estimatedTaxDue: 25.25, returnConfirmation: 'RET-1', paymentConfirmation: 'PAY-1', amountPaid: 25.25,
    documents: [
      { kind: 'return', href: `/api/documents?filing=${F_A_JAN}&kind=return` },
      { kind: 'payment', href: `/api/documents?filing=${F_A_JAN}&kind=payment` },
    ],
  });
  assert.deepEqual(data.sync, { asOf: '2026-10-22T03:00:00Z', status: 'ok' });
  assert.deepEqual(data.page, { limit: 50, offset: 0, hasMore: false });
  for (const hidden of ['connection', 'tenant_id', 'vendor', 'provider', 'raw_frequency', 'BETA-RET']) {
    assert.ok(!text.includes(hidden), `response leaks "${hidden}"`);
  }
});

test('paging reports whether there is more', async () => {
  const h = harness();
  const cookie = signedIn(h);
  const first = await body(await listFilings(get(filingsUrl(T_A, 'us_sales_tax', '&limit=2'), { cookie }), h.deps));
  assert.equal(first['filings'].length, 2);
  assert.equal(first['page'].hasMore, true);
  const second = await body(await listFilings(get(filingsUrl(T_A, 'us_sales_tax', '&limit=2&offset=2'), { cookie }), h.deps));
  assert.deepEqual(second['filings'].map((f: any) => f.id), [F_A_OLD]);
  assert.equal(second['page'].hasMore, false);
});

test("someone else's client looks exactly like a client that does not exist", async () => {
  const h = harness();
  const cookie = signedIn(h);
  const theirs = await listFilings(get(filingsUrl(T_B), { cookie }), h.deps);
  const nonexistent = await listFilings(get(filingsUrl('dddddddd-0000-4000-8000-00000000000d'), { cookie }), h.deps);
  assert.equal(theirs.status, 404);
  assert.equal(await theirs.text(), await nonexistent.text());

  const regs = await listRegistrations(get(`/api/registrations?tenant=${T_B}&product=us_sales_tax`, { cookie }), h.deps);
  assert.equal(regs.status, 404);
});

test('a product the client does not have is a plain 404', async () => {
  const h = harness();
  const res = await listFilings(get(filingsUrl(T_B, 'eu_vat'), { cookie: signedIn(h, USER_B) }), h.deps);
  assert.equal(res.status, 404);
});

test('bad parameters are rejected', async () => {
  const h = harness();
  const cookie = signedIn(h);
  for (const path of [
    '/api/filings?product=us_sales_tax',
    `/api/filings?tenant=not-a-uuid&product=us_sales_tax`,
    `/api/filings?tenant=${T_A}&product=crypto`,
    `/api/filings?tenant=${T_A}`,
    filingsUrl(T_A, 'us_sales_tax', '&limit=0'),
    filingsUrl(T_A, 'us_sales_tax', '&limit=201'),
    filingsUrl(T_A, 'us_sales_tax', '&limit=abc'),
    filingsUrl(T_A, 'us_sales_tax', '&offset=-1'),
  ]) {
    assert.equal((await listFilings(get(path, { cookie }), h.deps)).status, 400, path);
  }
});

test('data endpoints need a sign-in and only accept GET', async () => {
  const h = harness();
  assert.equal((await listFilings(get(filingsUrl(T_A)), h.deps)).status, 401);
  assert.equal((await listRegistrations(get(`/api/registrations?tenant=${T_A}&product=us_sales_tax`), h.deps)).status, 401);
  assert.equal((await downloadDocument(get(docUrl(F_A_JAN)), h.deps)).status, 401);
  const post = new Request('https://portal.example.com/api/filings', { method: 'POST' });
  assert.equal((await listFilings(post, h.deps)).status, 405);
});

test('everything a client sees is read through the client-scoped database, never the service role', async () => {
  const h = harness();
  await listFilings(get(filingsUrl(T_A), { cookie: signedIn(h) }), h.deps);
  await listRegistrations(get(`/api/registrations?tenant=${T_A}&product=us_sales_tax`, { cookie: signedIn(h) }), h.deps);
  assert.deepEqual(h.serviceDb.touched, [], 'listing must not use the service role');
  assert.ok(h.userDbs.length >= 2);
});

test('registrations show the provider\'s own frequency code only when we could not translate it', async () => {
  const h = harness();
  const data = await body(await listRegistrations(get(`/api/registrations?tenant=${T_A}&product=us_sales_tax`, { cookie: signedIn(h) }), h.deps));
  assert.deepEqual(data['registrations'], [
    { jurisdiction: 'KS', taxId: 'K100', startedAt: '2024-01-01', endedAt: null, frequency: 'monthly' },
    { jurisdiction: 'NY', taxId: 'N200', startedAt: '2024-06-01', endedAt: null, frequency: 'other', frequencyCode: 'NYQ' },
  ]);
  assert.deepEqual(data['sync'], { asOf: '2026-10-22T03:00:00Z', status: 'ok' });
});

test('a renewed login is carried through on data requests', async () => {
  const h = harness();
  const live = h.auth.session(USER_A);
  const res = await listFilings(get(filingsUrl(T_A), { cookie: cookiesFor({ ...live, accessToken: 'expired.jwt' }) }), h.deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.getSetCookie().length, 2);
});

// ------------------------------------------------------------------ document downloads

test('a download streams the file from our server, hides the provider, and is recorded', async () => {
  const h = harness();
  const res = await downloadDocument(get(docUrl(F_A_JAN), { cookie: signedIn(h) }), h.deps);

  assert.equal(res.status, 200);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [37, 80, 68, 70, 45, 49]);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="KS-2025-JAN-return.pdf"');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('location'), null, 'never redirect to the provider');
  assert.ok(![...res.headers.values()].some((v) => v.includes('files.example.invalid')), 'the provider link must not appear in any header');

  assert.deepEqual(h.audit.entries, [
    { tenantId: T_A, actorId: USER_A.id, action: 'document.download', target: `filing:${F_A_JAN}:return`, detail: { jurisdiction: 'KS', period: '2025-JAN' } },
  ]);
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.fetchCalls[0]!.protocol, 'https:');
});

test('the right provider is used, with the client\'s company id, and a fresh link is fetched every time', async () => {
  const h = harness();
  const cookie = signedIn(h);
  await downloadDocument(get(docUrl(F_A_JAN), { cookie }), h.deps);
  await downloadDocument(get(docUrl(F_A_JAN, 'payment'), { cookie }), h.deps);
  const adapter = h.adapters.get('vendor-x')!;
  assert.deepEqual(adapter.calls, [{ providerCompanyId: 'company-A' }, { providerCompanyId: 'company-A' }]);
  assert.equal(h.adapters.get('vendor-old')!.calls.length, 0);
  assert.equal(h.fetchCalls.length, 2);
});

test("someone else's filing is a 404: nothing is fetched, recorded or asked of the provider", async () => {
  const h = harness();
  const res = await downloadDocument(get(docUrl(F_B_JAN), { cookie: signedIn(h) }), h.deps);
  assert.equal(res.status, 404);
  const missing = await downloadDocument(get(docUrl('eeeeeeee-0000-4000-8000-00000000000e'), { cookie: signedIn(h) }), h.deps);
  assert.equal(await res.text(), await missing.text(), 'indistinguishable from a filing that does not exist');
  assert.equal(h.audit.entries.length, 0);
  assert.equal(h.fetchCalls.length, 0);
  assert.ok([...h.adapters.values()].every((a) => a.calls.length === 0));
  assert.deepEqual(h.serviceDb.touched, [], 'the service role is not used for an unauthorised request');
});

test('template documents are staff-only: clients neither see nor can fetch them, staff can', async () => {
  const h = harness();
  const client = await (await listFilings(get(filingsUrl(T_A), { cookie: signedIn(h) }), h.deps)).json();
  const jan = client.filings.find((f: any) => f.id === F_A_JAN);
  assert.deepEqual(jan.documents.map((d: any) => d.kind), ['return', 'payment'], 'no template link for a client');
  assert.equal((await downloadDocument(get(docUrl(F_A_JAN, 'template'), { cookie: signedIn(h) }), h.deps)).status, 404, 'a client typing the address gets nothing');
  const staff = await (await listFilings(get(filingsUrl(T_A), { cookie: signedIn(h, USER_STAFF) }), h.deps)).json();
  assert.deepEqual(staff.filings.find((f: any) => f.id === F_A_JAN).documents.map((d: any) => d.kind), ['return', 'payment', 'template'], 'staff still see it');
});

test('only documents that exist can be requested', async () => {
  const h = harness();
  const cookie = signedIn(h);
  assert.equal((await downloadDocument(get(docUrl(F_A_JAN, 'template'), { cookie }), h.deps)).status, 404, 'kind not on this filing');
  assert.equal((await downloadDocument(get(docUrl(F_A_FEB), { cookie }), h.deps)).status, 404, 'filing has no documents');
  assert.equal((await downloadDocument(get(docUrl(F_A_JAN, 'passwords'), { cookie }), h.deps)).status, 400);
  assert.equal((await downloadDocument(get(docUrl('nope'), { cookie }), h.deps)).status, 400);
  assert.equal(h.audit.entries.length, 0);
});

test('history from a replaced provider can still be downloaded', async () => {
  const h = harness();
  // The earlier provider still holds the Q4 2024 Texas return.
  h.adapters.set('vendor-old', new MockAdapter({
    key: 'vendor-old',
    filings: [canonFiling({ jurisdiction: 'TX', periodCode: '2024-Q4', dueOn: '2025-01-20', documents: [{ kind: 'return' }] })],
  }));
  const res = await downloadDocument(get(docUrl(F_A_OLD), { cookie: signedIn(h) }), h.deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="TX-2024-Q4-return.pdf"');
  assert.deepEqual(h.adapters.get('vendor-old')!.calls, [{ providerCompanyId: null }], 'routed to the connection that holds this filing');
  assert.equal(h.adapters.get('vendor-x')!.calls.length, 0);
});

test('if the access cannot be recorded, nothing is served', async () => {
  const h = harness();
  h.audit.failing = true;
  const res = await downloadDocument(get(docUrl(F_A_JAN), { cookie: signedIn(h) }), h.deps);
  assert.equal(res.status, 503);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.adapters.get('vendor-x')!.calls.length, 0);
});

test('provider trouble becomes a generic message that never names the provider', async () => {
  const h = harness();
  const cookie = signedIn(h);
  h.adapters.get('vendor-x')!.getDocumentLink = async () => {
    throw new ProviderError('upstream', 'vendor-x', 'vendor-x exploded at https://secret.vendor-x.example/internal');
  };
  const res = await downloadDocument(get(docUrl(F_A_JAN), { cookie }), h.deps);
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!/vendor|secret|exploded/i.test(text), text);
  assert.ok(h.logs.some((l) => l.event === 'document.provider_error'));
});

test('a provider that cannot find the document gives a 404', async () => {
  const h = harness();
  h.adapters.get('vendor-x')!.getDocumentLink = async () => { throw new ProviderError('not_found', 'vendor-x', 'gone'); };
  assert.equal((await downloadDocument(get(docUrl(F_A_JAN), { cookie: signedIn(h) }), h.deps)).status, 404);
});

test('bad provider links and failed fetches are handled safely', async () => {
  const insecure = harness();
  insecure.adapters.get('vendor-x')!.getDocumentLink = async () => ({ url: 'http://files.example.invalid/x.pdf', expiresAt: null });
  assert.equal((await downloadDocument(get(docUrl(F_A_JAN), { cookie: signedIn(insecure) }), insecure.deps)).status, 502);
  assert.equal(insecure.fetchCalls.length, 0, 'a plain-http link is never fetched');

  const garbage = harness();
  garbage.adapters.get('vendor-x')!.getDocumentLink = async () => ({ url: 'not a url', expiresAt: null });
  assert.equal((await downloadDocument(get(docUrl(F_A_JAN), { cookie: signedIn(garbage) }), garbage.deps)).status, 502);

  const failing = harness();
  failing.setUpstream(() => new Response('denied', { status: 403 }));
  assert.equal((await downloadDocument(get(docUrl(F_A_JAN), { cookie: signedIn(failing) }), failing.deps)).status, 502);

  const unreachable = harness();
  unreachable.setUpstream(() => new Error('socket hang up'));
  assert.equal((await downloadDocument(get(docUrl(F_A_JAN), { cookie: signedIn(unreachable) }), unreachable.deps)).status, 502);
});

test('only known file types are passed through; anything else is an opaque download', async () => {
  const cases: [string, string, string][] = [
    ['application/pdf', 'application/pdf', '.pdf'],
    ['application/pdf; charset=binary', 'application/pdf', '.pdf'],
    ['text/csv', 'text/csv', '.csv'],
    ['text/html', 'application/octet-stream', '.bin'],
    ['image/svg+xml', 'application/octet-stream', '.bin'],
    ['', 'application/octet-stream', '.bin'],
  ];
  for (const [declared, served, ext] of cases) {
    const h = harness();
    h.setUpstream(() => new Response('<script>alert(1)</script>', { headers: declared ? { 'content-type': declared } : {} }));
    const res = await downloadDocument(get(docUrl(F_A_JAN), { cookie: signedIn(h) }), h.deps);
    assert.equal(res.headers.get('content-type'), served, declared);
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="KS-2025-JAN-return${ext}"`, declared);
  }
});

test('downloads are rate limited per person', async () => {
  const h = harness();
  const cookie = signedIn(h);
  const { limit } = LIMITS.download.perUser;
  for (let i = 0; i < limit; i++) {
    assert.equal((await downloadDocument(get(docUrl(F_A_JAN), { cookie }), h.deps)).status, 200);
  }
  const blocked = await downloadDocument(get(docUrl(F_A_JAN), { cookie }), h.deps);
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
  assert.equal(h.fetchCalls.length, limit);
});

test('the connection used for a download comes from the filing, never from anything the client sends', async () => {
  const h = harness();
  const url = `${docUrl(F_A_JAN)}&connection=${C_A_OLD}&provider=vendor-old`;
  await downloadDocument(get(url, { cookie: signedIn(h) }), h.deps);
  assert.equal(h.adapters.get('vendor-x')!.calls.length, 1);
  assert.equal(h.adapters.get('vendor-old')!.calls.length, 0);
});
