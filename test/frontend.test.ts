// @ts-nocheck  (the browser code under public/ is plain JavaScript)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createApi, ApiError } from '../public/js/api.js';
import * as F from '../public/js/format.js';

function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return responder(url, init); };
  fn.calls = calls;
  return fn;
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// ------------------------------------------------------------------ api client

test('GET calls send cookies and build safe query strings', async () => {
  const f = fakeFetch(() => json(200, { filings: [] }));
  await createApi({ fetch: f }).filings({ tenant: 'a b&c', product: 'us_sales_tax', limit: 25, offset: 50 });
  assert.equal(f.calls[0].init.credentials, 'same-origin');
  assert.equal(f.calls[0].url, '/api/filings?tenant=a+b%26c&product=us_sales_tax&limit=25&offset=50');
});

test('login calls are JSON POSTs to the right endpoints', async () => {
  const f = fakeFetch(() => json(200, { ok: true }));
  const api = createApi({ fetch: f });
  await api.requestCode('a@b.co');
  await api.verifyCode('a@b.co', '123456');
  await api.logout();
  assert.deepEqual(f.calls.map((c) => [c.url, c.init.method]), [['/api/auth/request-code', 'POST'], ['/api/auth/verify-code', 'POST'], ['/api/auth/logout', 'POST']]);
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { email: 'a@b.co', code: '123456' });
});

test('a 401 on a data call signals sign-out, but a wrong code on the login form does not', async () => {
  let signedOut = 0;
  const f = fakeFetch(() => json(401, { error: { code: 'invalid_code', message: 'That code is incorrect or has expired.' } }));
  const api = createApi({ fetch: f, onUnauthorized: () => { signedOut += 1; } });
  await assert.rejects(api.session(), (e) => e instanceof ApiError && e.status === 401);
  assert.equal(signedOut, 1);
  await assert.rejects(api.verifyCode('a@b.co', '123456'), (e) => e.code === 'invalid_code' && e.message.includes('incorrect'));
  assert.equal(signedOut, 1, 'login-form 401 must not look like an expired session');
});

test('errors carry the server message and Retry-After; odd responses get safe generic text', async () => {
  const limited = createApi({ fetch: fakeFetch(() => json(429, { error: { code: 'rate_limited', message: 'Slow down.' } }, { 'Retry-After': '900' })) });
  await assert.rejects(limited.session(), (e) => e.status === 429 && e.retryAfter === 900 && e.message === 'Slow down.');

  const html = createApi({ fetch: fakeFetch(() => new Response('<html>boom</html>', { status: 502 })) });
  await assert.rejects(html.session(), (e) => e.status === 502 && !e.message.includes('boom') && e.message.length > 0);

  const down = createApi({ fetch: fakeFetch(() => { throw new TypeError('failed to fetch'); }) });
  await assert.rejects(down.session(), (e) => e.status === 0 && e.code === 'network');

  const weird = createApi({ fetch: fakeFetch(() => new Response('null', { status: 200 })) });
  await assert.rejects(weird.session(), (e) => e.code === 'bad_response');
});

// ------------------------------------------------------------------ formatting

test('dates are calendar dates, not shifted by time zone', () => {
  assert.equal(F.formatDate('2026-04-20'), '20 Apr 2026');
  assert.equal(F.formatDate('2026-01-01T00:00:00Z'), '1 Jan 2026');
  for (const bad of [null, undefined, '', 'nope', '2026-13-01']) assert.equal(F.formatDate(bad), '—');
});

test('money: USD for US sales tax, plain amounts for VAT (currency not yet known), dash when missing', () => {
  assert.equal(F.formatMoney(1234.5, 'us_sales_tax'), '$1,234.50');
  assert.equal(F.formatMoney('12.5', 'us_sales_tax'), '$12.50');
  assert.equal(F.formatMoney(1234.5, 'eu_vat'), '1,234.50');
  for (const bad of [null, undefined, '', 'abc', NaN]) assert.equal(F.formatMoney(bad, 'us_sales_tax'), '—');
  assert.equal(F.formatMoney(0, 'us_sales_tax'), '$0.00');
});

test('frequency: known values are labelled, unknown ones keep the raw code', () => {
  assert.equal(F.frequencyLabel('quarterly'), 'Quarterly');
  assert.equal(F.frequencyLabel('other', 'NYQP'), 'Other (NYQP)');
  assert.equal(F.frequencyLabel(null), '—');
});

test('freshness notes: pending, stale (with the as-of time) and ok are different', () => {
  assert.match(F.syncNote({ status: 'pending', asOf: null }).text, /being set up/);
  const stale = F.syncNote({ status: 'stale', asOf: '2026-10-20T01:00:00Z' });
  assert.equal(stale.tone, 'stale');
  assert.match(stale.text, /may be out of date/);
  assert.equal(F.syncNote({ status: 'ok', asOf: '2026-10-20T01:00:00Z' }).tone, 'ok');
  assert.equal(F.syncNote(null).text, '');
  assert.equal(F.syncBanner(null), '');
});

test('filing status and summary use the due date only for unfiled returns', () => {
  const today = '2026-10-22';
  const filed = { isCompleted: true, dueOn: '2026-01-20', jurisdiction: 'TX' };
  const late = { isCompleted: false, dueOn: '2026-10-01', jurisdiction: 'CA' };
  const soon = { isCompleted: false, dueOn: '2026-11-20', jurisdiction: 'NY' };
  const later = { isCompleted: false, dueOn: '2026-12-20', jurisdiction: 'WA' };
  assert.equal(F.filingStatus(filed, today).key, 'complete');
  assert.equal(F.filingStatus(late, today).key, 'overdue');
  assert.equal(F.filingStatus(soon, today).key, 'upcoming');
  const s = F.summarize([filed, late, soon, later], today);
  assert.deepEqual({ c: s.complete, u: s.upcoming, o: s.overdue }, { c: 1, u: 2, o: 1 });
  assert.equal(s.next.jurisdiction, 'CA', 'the earliest unfiled due date is next');
});

// ------------------------------------------------------------------ rendering is safe and honest

const EVIL = '<img src=x onerror=alert(1)>"\'';
test('every server-supplied string is escaped before it reaches HTML', () => {
  const filings = [{ id: 'f1', jurisdiction: EVIL, periodCode: EVIL, periodName: EVIL, frequency: 'other', dueOn: '2026-01-01', isCompleted: false, estimatedTaxDue: 5, amountPaid: null, documents: [{ kind: 'return', href: '/api/documents?filing=f1&kind=return' }] }];
  const regs = [{ jurisdiction: EVIL, taxId: EVIL, startedAt: '2026-01-01', endedAt: null, frequency: 'other', frequencyCode: EVIL }];
  const html = [F.filingsTable(filings, 'us_sales_tax', '2026-10-22'), F.registrationsTable(regs), F.overview(filings, regs, 'us_sales_tax', '2026-10-22'), F.overview(filings, regs, 'eu_vat', '2026-10-22'), F.nexusPage(), F.syncBanner({ status: 'stale', asOf: EVIL }), F.errorState(EVIL), F.emptyState(EVIL)].join('');
  assert.ok(!html.includes('<img'), 'raw markup leaked');
  assert.ok(html.includes('&lt;img'));
});

test('only our own document paths become links', () => {
  const mk = (href) => F.filingsTable([{ id: 'f', jurisdiction: 'TX', periodCode: 'Q1', dueOn: '2026-01-01', isCompleted: true, documents: [{ kind: 'return', href }] }], 'us_sales_tax');
  assert.match(mk('/api/documents?filing=f&kind=return'), /href="\/api\/documents\?filing=f&amp;kind=return"/);
  for (const bad of ['https://evil.example/x.pdf', 'javascript:alert(1)', '//evil.example', '/other']) assert.ok(!mk(bad).includes('<a '), bad);
});

test('empty lists say so, and nexus shows an honest placeholder with no invented numbers', () => {
  assert.match(F.filingsTable([], 'us_sales_tax'), /No filings/);
  assert.match(F.registrationsTable([]), /No registrations/);
  const n = F.nexusCard() + F.nexusPage();
  assert.match(n, /[Nn]exus/);
  assert.ok(!/\d/.test(n.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').replace(/&#?\w+;/g, '')), 'no figures in the nexus placeholders');
  assert.match(F.overview([], [], 'us_sales_tax', '2026-10-22'), /Estimated tax/);
});

test('dashboard figures come only from real filings', () => {
  const today = '2026-10-22';
  const f = (id, dueOn, done, amt) => ({ id, jurisdiction: id, periodName: 'P', dueOn, isCompleted: done, estimatedTaxDue: amt, documents: [] });
  const filings = [f('A', '2026-10-30', false, 100), f('B', '2026-10-01', false, 50), f('C', '2027-03-01', false, 999), f('D', '2026-10-25', true, 7)];
  const l = F.liabilitySummary(filings, today);
  assert.equal(l.total, 100, 'only unfiled returns due within 30 days');
  const a = F.actionItems(filings, today);
  assert.deepEqual(a.map((x) => x.html.match(/<strong>(\w+)</)[1]), ['B', 'A'], 'overdue first, then soonest; filed and far-off excluded');
  const html = F.overview(filings, [], 'us_sales_tax', today);
  assert.match(html, /\$100\.00/);
  assert.ok(!/hero-stat[\s\S]{0,400}999/.test(html), 'far-off filing is not in the 30-day total');
});

test('the pager only appears when there is somewhere to go', () => {
  assert.equal(F.pager({ limit: 25, offset: 0, hasMore: false }), '');
  assert.match(F.pager({ limit: 25, offset: 0, hasMore: true }), /page-next/);
  assert.match(F.pager({ limit: 25, offset: 25, hasMore: false }), /data-action="page-prev"\s*>/);
});

// ------------------------------------------------------------------ the page is CSP-clean and prototype leftovers are gone

test('no inline scripts, handlers or styles (the Content-Security-Policy forbids them)', () => {
  const files = ['public/index.html', ...readdirSync('public/js').map((f) => `public/js/${f}`)];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/\son[a-z]+\s*=/.test(src), `${f}: inline event handler`);
    assert.ok(!/\sstyle\s*=/.test(src), `${f}: inline style attribute`);
    if (f.endsWith('.html')) assert.ok(!/<script(?![^>]*\bsrc=)/.test(src), `${f}: inline script`);
  }
  const csp = JSON.parse(readFileSync('vercel.json', 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.ok(/script-src 'self'(;|$)/.test(csp) && !/unsafe-inline.*script|script-src[^;]*unsafe/.test(csp));
  assert.match(csp, /frame-ancestors 'none'/);
});

test('no prototype leftovers: demo data, demo login, vendor names or provider wording', () => {
  const all = ['public/index.html', 'public/styles.css', ...readdirSync('public/js').map((f) => `public/js/${f}`)].map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const word of [/zamp/i, /lumen/i, /jordan reyes/i, /demo/i, /seed[A-Z]/, /Powered by/i]) assert.ok(!word.test(all), String(word));
});

// ------------------------------------------------------------------ staff screen

import * as S from '../public/js/staff.js';

test('the staff screen escapes everything the server sends, and shows no vendor names of its own', () => {
  const st = S.freshStaff();
  st.status = 'ready';
  st.providers = [{ key: 'v1', label: EVIL }];
  st.clients = [{ id: 'c1', name: EVIL, users: 2, connections: [{ id: 'k1', product: 'us_sales_tax', provider: 'v1', status: 'active', lastSyncedAt: null, lastSyncStatus: 'failed', lastSyncError: EVIL }] }];
  st.result = { name: EVIL, email: EVIL, invite: 'created', sync: { status: 'failed', error: EVIL } };
  st.notice = { tone: 'error', text: EVIL };
  st.formError = EVIL;
  const html = S.staffPage(st);
  assert.ok(!html.includes('<img'), 'raw markup leaked');
  assert.ok(html.includes('&lt;img'));
  assert.ok(!/zamp/i.test(readFileSync('public/js/staff.js', 'utf8')), 'staff.js is served to everyone and must not name a vendor');
});

test('the token box is a password field that never pre-fills from the server, and the form offers only the providers staff are told about', () => {
  const st = S.freshStaff();
  st.providers = [{ key: 'p1', label: 'P One' }];
  const html = S.addClientForm(st);
  assert.match(html, /id="token" name="token" type="password" value=""/);
  assert.match(html, /autocomplete="off"/);
  assert.match(html, /<option value="p1" selected>P One<\/option>/);
});

test('result notes tell staff what happened to the invite and the first refresh', () => {
  const ok = S.resultNote({ name: 'Acme', email: 'a@b.test', invite: 'created', sync: { status: 'succeeded', registrations: 3, filings: 0 } });
  assert.match(ok, /form-info/);
  assert.match(ok, /3 registration/);
  assert.match(ok, /sign-in has been created/);
  const bad = S.resultNote({ name: 'Acme', email: 'a@b.test', invite: 'failed', sync: { status: 'failed', error: 'down' } });
  assert.match(bad, /form-error/);
  assert.match(bad, /could not be set up/);
  assert.equal(S.resultNote(null), '');
});

test('the client table offers "Refresh now" only for active connections, and disables the one in progress', () => {
  const clients = [{ id: 'c', name: 'A', users: 0, connections: [{ id: 'k1', product: 'us_sales_tax', provider: 'p', status: 'active', lastSyncedAt: '2026-11-06T01:00:00Z', lastSyncStatus: 'succeeded', lastSyncError: null }, { id: 'k2', product: 'us_sales_tax', provider: 'p', status: 'paused', lastSyncedAt: null, lastSyncStatus: null, lastSyncError: null }] }];
  const html = S.clientsTable(clients, 'k1');
  assert.equal((html.match(/data-action="staff-sync"/g) ?? []).length, 1);
  assert.match(html, /disabled>Refreshing/);
  assert.match(S.clientsTable([], null), /No clients yet/);
});

test('when a client has two services, each refresh button says which service it refreshes', () => {
  const conn = (id, product) => ({ id, product, provider: 'p', status: 'active', lastSyncedAt: null, lastSyncStatus: null, lastSyncError: null });
  const html = S.clientsTable([{ id: 'c', name: 'A', users: 1, connections: [conn('k1', 'us_sales_tax'), conn('k2', 'eu_vat')] }], null);
  assert.match(html, />Refresh US Sales Tax</);
  assert.match(html, />Refresh VAT</);
  assert.match(S.clientsTable([{ id: 'c', name: 'A', users: 1, connections: [conn('k1', 'us_sales_tax')] }], null), />Refresh now</);
});
