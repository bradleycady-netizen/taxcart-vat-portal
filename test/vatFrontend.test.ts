import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain browser modules
import { esc, daysUntil, dueText, fmtDate, fileSize, money } from '../public/vat/js/format.js';
// @ts-expect-error plain browser modules
import { flag } from '../public/vat/js/flags.js';
// @ts-expect-error plain browser modules
import { returnCard, detailPage, staffQueue, uploadPage } from '../public/vat/js/views.js';
import { readFileSync } from 'node:fs';

const ret = (over: Record<string, unknown> = {}) => ({ id: 'r1', tenantId: 't1', tenantName: '<img src=x onerror=alert(1)>', scheme: 'ioss', schemeLabel: 'IOSS', country: 'PL', countryName: 'Poland', periodLabel: 'Sep 2026', periodEnd: '2026-09-30', dueOn: '2026-10-31', status: 'received', awaitingClient: false, filedAt: null, upload: null, returnFile: null, question: null, ...over });

test('dates and sizes are written plainly and are never shifted by time zone', () => {
  assert.equal(fmtDate('2026-11-30'), '30 Nov 2026');
  assert.equal(fmtDate('2026-11-30', true), '30 Nov');
  assert.equal(fmtDate('nonsense'), '');
  const now = new Date(2026, 9, 22, 23, 59);
  assert.equal(daysUntil('2026-10-31', now), 9);
  assert.equal(daysUntil('2026-10-20', now), -2);
  assert.equal(dueText('2026-10-23', now), '23 Oct · 1 day');
  assert.equal(dueText('2026-10-20', now), '20 Oct · 2 days overdue');
  assert.equal(fileSize(2048), '2 KB');
  assert.equal(money(1234.5, 'EUR'), '1,234.50 EUR');
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('every country gets a flag or a code badge, and nothing unexpected is injected', () => {
  assert.match(flag('PL'), /<svg/);
  assert.match(flag('GR'), />GR</, 'a country without a drawing shows its code');
  assert.ok(!flag('"><script>').includes('<script>'));
});

test('text that comes from clients and staff is escaped everywhere it is shown', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = returnCard(ret({ awaitingClient: true, question: { body: evil } })) + staffQueue({ status: 'ready', returns: [ret()] }, { status: '', country: '', client: '' }, new Date()) +
    detailPage({ status: 'ready', ret: ret(), events: [{ id: 'e', side: 'client', kind: 'reply', body: evil, at: '2026-10-01T10:00:00Z' }], uploadSummary: null, notice: { tone: 'info', text: evil } }, true);
  assert.ok(!html.includes('<img src=x'), 'raw markup must never appear');
  assert.ok(html.includes('&lt;img src=x'));
});

test('the finished-return button only appears when a file exists, and clients see the right progress', () => {
  assert.ok(!returnCard(ret()).includes('VAT return (PDF)'));
  assert.ok(returnCard(ret({ returnFile: { name: 'r.pdf', bytes: 10 }, status: 'complete' })).includes('VAT return (PDF)'));
  assert.equal((returnCard(ret({ status: 'in_review' })).match(/seg done/g) ?? []).length, 2);
});

test('the upload page offers only the periods of the chosen filing', () => {
  const reg = { id: 'g1', scheme: 'ioss', schemeLabel: 'IOSS', country: 'PL', countryName: 'Poland', frequency: 'monthly', periods: [{ code: '2026-09', label: 'Sep 2026', dueOn: '2026-10-31', returnId: null, status: null }, { code: '2026-08', label: 'Aug 2026', dueOn: '2026-09-30', returnId: 'x', status: 'received' }] };
  const html = uploadPage({ status: 'ready', registrations: [reg], returns: [] }, { regId: 'g1', period: '2026-08', file: null, status: 'idle', result: null, error: '', over: false });
  assert.match(html, /Aug 2026 — already with Taxcart/);
  assert.match(html, /Taxcart has already started on this period/);
  assert.ok(!html.includes('file-input'), 'no file picker for a period that is already being worked on');
});

test('the VAT pages respect the content security policy: no inline styles or scripts, no outside requests but fonts', () => {
  for (const f of ['public/vat/index.html', 'public/vat/js/views.js', 'public/vat/js/app.js', 'public/vat/js/flags.js']) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/\sstyle=["']/.test(src), `${f} has an inline style attribute`);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(src), `${f} has an inline script`);
    assert.ok(!/\son(click|error|load|change|submit)=/i.test(src), `${f} has an inline event handler`);
  }
  const css = readFileSync('public/vat/vat.css', 'utf8');
  assert.ok(!/url\(\s*['"]?https?:/i.test(css), 'the stylesheet loads nothing from outside');
  const html = readFileSync('public/vat/index.html', 'utf8');
  for (const m of html.matchAll(/(?:href|src)="(https?:[^"]+)"/g)) assert.match(m[1]!, /^https:\/\/fonts\.(googleapis|gstatic)\.com/);
  for (const f of ['public/vat/js/views.js', 'public/vat/js/app.js']) assert.ok(!/zamp/i.test(readFileSync(f, 'utf8')), 'no vendor names in the client pages');
});
