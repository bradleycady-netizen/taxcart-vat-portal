import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZampAdapter } from '../src/providers/zamp/adapter.ts';
import { ProviderError } from '../src/core/errors.ts';
import { fakeFetch, json, noSleep } from './helpers.ts';
import { filingFeb, filingJan, filingsPage, registrationsBody } from './fixtures/zamp.ts';

const ctx = { providerCompanyId: null };
const SECRET = 'zk_live_SUPERSECRET';

function adapter(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new ZampAdapter({ apiKey: SECRET, fetchImpl, sleep: noSleep, ...extra });
}

async function rejects(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ProviderError, `expected ProviderError, got ${String(e)}`);
    return e;
  }
  assert.fail('expected a rejection');
}

test('maps a documented registration to the canonical model', async () => {
  const { fetch } = fakeFetch(() => json(registrationsBody));
  const regs = await adapter(fetch).listRegistrations(ctx);
  assert.deepEqual(regs, [
    { jurisdiction: 'KS', taxId: 'K100234567', startedAt: '2024-01-01', endedAt: null, frequency: 'monthly', rawFrequencyCode: 'M' },
  ]);
});

test('unrecognised frequency codes become "other" but the raw code is preserved', async () => {
  const body = [{ ...registrationsBody[0]!, frequencies: [{ code: 'NYQ', startedAt: '2024-01-01', endedAt: null }] }];
  const { fetch } = fakeFetch(() => json(body));
  const [reg] = await adapter(fetch).listRegistrations(ctx);
  assert.equal(reg!.frequency, 'other');
  assert.equal(reg!.rawFrequencyCode, 'NYQ');
});

test('picks the open-ended frequency when several exist', async () => {
  const body = [
    {
      ...registrationsBody[0]!,
      frequencies: [
        { code: 'Q', startedAt: '2022-01-01', endedAt: '2023-12-31' },
        { code: 'M', startedAt: '2024-01-01', endedAt: null },
      ],
    },
  ];
  const { fetch } = fakeFetch(() => json(body));
  const [reg] = await adapter(fetch).listRegistrations(ctx);
  assert.equal(reg!.rawFrequencyCode, 'M');
});

test('maps a documented filing, keeps confirmations and amounts, and never stores signed links', async () => {
  const { fetch } = fakeFetch(() => json(filingsPage([filingJan])));
  const [f] = await adapter(fetch).listFilings(ctx);
  assert.equal(f!.externalId, 'KS:2025-JAN');
  assert.equal(f!.returnConfirmation, '7291-QXMF-8K63');
  assert.equal(f!.amountPaid, 25.25);
  assert.equal(f!.frequency, 'monthly');
  assert.deepEqual(f!.documents, [{ kind: 'return' }, { kind: 'payment' }]);
  assert.ok(!JSON.stringify(f).includes('signedUrl'));
  assert.ok(!JSON.stringify(f).includes('files.example.invalid'));
});

test('follows cursors across pages', async () => {
  const { fetch, calls } = fakeFetch([
    () => json(filingsPage([filingJan], 'cursor-2')),
    () => json(filingsPage([filingFeb], null)),
  ]);
  const filings = await adapter(fetch).listFilings(ctx);
  assert.deepEqual(filings.map((f) => f.externalId), ['KS:2025-JAN', 'KS:2025-FEB']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url.searchParams.get('cursor'), null);
  assert.equal(calls[1]!.url.searchParams.get('cursor'), 'cursor-2');
});

test('rejects a provider that repeats a cursor forever', async () => {
  const { fetch } = fakeFetch(() => json(filingsPage([filingJan], 'same')));
  const err = await rejects(adapter(fetch).listFilings(ctx));
  assert.equal(err.kind, 'bad_response');
});

test('passes companyId only when a partner company is set', async () => {
  const a = fakeFetch(() => json(registrationsBody));
  await adapter(a.fetch).listRegistrations({ providerCompanyId: 'cmp_123' });
  assert.equal(a.calls[0]!.url.searchParams.get('companyId'), 'cmp_123');

  const b = fakeFetch(() => json(registrationsBody));
  await adapter(b.fetch).listRegistrations({ providerCompanyId: null });
  assert.equal(b.calls[0]!.url.searchParams.has('companyId'), false);
});

test('passes filing filters through as query parameters', async () => {
  const { fetch, calls } = fakeFetch(() => json(filingsPage([])));
  await adapter(fetch).listFilings(ctx, { jurisdiction: 'KS', minDueOn: '2025-02-01', maxDueOn: '2025-02-28', isCompleted: true });
  const q = calls[0]!.url.searchParams;
  assert.equal(q.get('state'), 'KS');
  assert.equal(q.get('minDueOn'), '2025-02-01');
  assert.equal(q.get('maxDueOn'), '2025-02-28');
  assert.equal(q.get('isCompleted'), 'true');
});

test('sends the bearer token, and the key never appears in errors', async () => {
  const ok = fakeFetch(() => json(registrationsBody));
  await adapter(ok.fetch).listRegistrations(ctx);
  assert.equal(new Headers(ok.calls[0]!.init!.headers).get('authorization'), `Bearer ${SECRET}`);

  const denied = fakeFetch(() => json({ message: 'nope' }, 401));
  const err = await rejects(adapter(denied.fetch).listRegistrations(ctx));
  assert.equal(err.kind, 'auth');
  assert.ok(!err.message.includes(SECRET));
  assert.equal(denied.calls.length, 1, 'auth failures must not be retried');
});

test('an empty API key is a configuration error', () => {
  assert.throws(() => new ZampAdapter({ apiKey: '' }), (e: unknown) => e instanceof ProviderError && e.kind === 'config');
});

test('retries on 429, honouring Retry-After', async () => {
  const sleeps: number[] = [];
  const { fetch, calls } = fakeFetch([
    () => json({}, 429, { 'retry-after': '2' }),
    () => json(registrationsBody),
  ]);
  const a = new ZampAdapter({ apiKey: SECRET, fetchImpl: fetch, sleep: async (ms) => void sleeps.push(ms) });
  const regs = await a.listRegistrations(ctx);
  assert.equal(regs.length, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('retries 5xx with backoff, then reports an upstream error', async () => {
  const sleeps: number[] = [];
  const { fetch, calls } = fakeFetch(() => json({ error: 'boom' }, 503));
  const a = new ZampAdapter({ apiKey: SECRET, fetchImpl: fetch, maxRetries: 3, sleep: async (ms) => void sleeps.push(ms) });
  const err = await rejects(a.listRegistrations(ctx));
  assert.equal(err.kind, 'upstream');
  assert.equal(err.retryable, true);
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
});

test('recovers from a transient network error', async () => {
  const { fetch, calls } = fakeFetch([() => new Error('socket hang up'), () => json(registrationsBody)]);
  const regs = await adapter(fetch).listRegistrations(ctx);
  assert.equal(regs.length, 1);
  assert.equal(calls.length, 2);
});

test('other 4xx responses are bad_request and not retried', async () => {
  const { fetch, calls } = fakeFetch(() => json({ error: 'invalid' }, 422));
  const err = await rejects(adapter(fetch).listRegistrations(ctx));
  assert.equal(err.kind, 'bad_request');
  assert.equal(calls.length, 1);
});

test('malformed responses become bad_response, not crashes', async () => {
  for (const body of [{ nope: true }, { data: 'x' }, { data: [{ state: 'KS' }] }, { data: [{ ...filingJan, isCompleted: 'yes' }] }]) {
    const { fetch } = fakeFetch(() => json(body));
    const err = await rejects(adapter(fetch).listFilings(ctx));
    assert.equal(err.kind, 'bad_response');
  }
  const notJson = fakeFetch(() => new Response('<html>gateway</html>', { status: 200 }));
  assert.equal((await rejects(adapter(notJson.fetch).listRegistrations(ctx))).kind, 'bad_response');
});

test('getDocumentLink mints a fresh link by re-querying the exact filing', async () => {
  const { fetch, calls } = fakeFetch(() => json(filingsPage([filingJan])));
  const now = Date.parse('2026-10-22T00:00:00.000Z');
  const link = await adapter(fetch, { now: () => now }).getDocumentLink(ctx, {
    jurisdiction: 'KS',
    periodCode: '2025-JAN',
    dueOn: '2025-02-25',
    kind: 'payment',
  });
  assert.equal(link.url, 'https://files.example.invalid/ks-jan-payment?sig=def');
  assert.equal(link.expiresAt, '2026-10-22T00:55:00.000Z');
  const q = calls[0]!.url.searchParams;
  assert.equal(q.get('state'), 'KS');
  assert.equal(q.get('minDueOn'), '2025-02-25');
  assert.equal(q.get('maxDueOn'), '2025-02-25');
});

test('getDocumentLink reports not_found when the document does not exist', async () => {
  const { fetch } = fakeFetch(() => json(filingsPage([filingJan])));
  const err = await rejects(
    adapter(fetch).getDocumentLink(ctx, { jurisdiction: 'KS', periodCode: '2025-JAN', dueOn: '2025-02-25', kind: 'template' }),
  );
  assert.equal(err.kind, 'not_found');
});

test('declares only the capabilities the public docs support', () => {
  const caps = adapter(fakeFetch(() => json([])).fetch).capabilities;
  assert.deepEqual(caps, {
    registrations: true,
    filings: true,
    documents: true,
    nexusTracking: false,
    registrationApproval: false,
    webhooks: false,
  });
});
