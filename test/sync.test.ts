import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZampAdapter } from '../src/providers/zamp/adapter.ts';
import { MockAdapter } from '../src/providers/mock/adapter.ts';
import { ProviderError } from '../src/core/errors.ts';
import { buildAdapter, registerAdapter } from '../src/providers/registry.ts';
import { syncAll, syncConnection } from '../src/sync/sync.ts';
import type { ProviderAdapter } from '../src/core/types.ts';
import {
  InMemoryStore,
  canonFiling,
  canonRegistration,
  connection,
  fakeFetch,
  json,
  noSleep,
} from './helpers.ts';
import { filingFeb, filingJan, filingsPage, registrationsBody } from './fixtures/zamp.ts';

const fixedNow = () => new Date('2026-10-22T03:00:00.000Z');

function zampAdapter() {
  const { fetch } = fakeFetch((url) =>
    url.pathname === '/registrations' ? json(registrationsBody) : json(filingsPage([filingJan, filingFeb])),
  );
  return new ZampAdapter({ apiKey: 'k', fetchImpl: fetch, sleep: noSleep });
}

function vatMock() {
  return new MockAdapter({
    key: 'vat-vendor',
    registrations: [canonRegistration({ jurisdiction: 'DE' }), canonRegistration({ jurisdiction: 'FR', taxId: 'FR9' })],
    filings: [canonFiling({ externalId: 'DE:2026-Q2' }), canonFiling({ externalId: 'FR:2026-Q2', jurisdiction: 'FR' })],
  });
}

test('one client, two products, two providers, synced side by side', async () => {
  const store = new InMemoryStore();
  const us = connection({ tenantId: 'acme', product: 'us_sales_tax', providerKey: 'zamp' });
  const vat = connection({ tenantId: 'acme', product: 'eu_vat', providerKey: 'vat-vendor' });
  const adapters = new Map<string, ProviderAdapter>([
    [us.id, zampAdapter()],
    [vat.id, vatMock()],
  ]);

  const results = await syncAll([us, vat], (c) => adapters.get(c.id)!, store, { now: fixedNow });

  assert.deepEqual(results.map((r) => r.status), ['succeeded', 'succeeded']);
  assert.deepEqual(store.filingsFor(us.id), ['KS:2025-FEB', 'KS:2025-JAN']);
  assert.deepEqual(store.filingsFor(vat.id), ['DE:2026-Q2', 'FR:2026-Q2']);
  assert.deepEqual(store.registrationsFor(us.id), ['KS']);
  assert.deepEqual(store.registrationsFor(vat.id), ['DE', 'FR']);
  // Both rows belong to the same tenant but stay attributed to their own connection.
  assert.ok([...store.filings.values()].every((f) => f.tenantId === 'acme'));
});

test('an outage leaves the cached copy untouched and does not advance "last synced"', async () => {
  const store = new InMemoryStore();
  const c = connection({ providerKey: 'vat-vendor', product: 'eu_vat' });
  const mock = vatMock();

  const first = await syncConnection(c, mock, store, { now: fixedNow });
  assert.equal(first.status, 'succeeded');
  const syncedAt = store.state.get(c.id)!.lastSyncedAt;
  assert.equal(syncedAt, '2026-10-22T03:00:00.000Z');
  const before = store.filingsFor(c.id);

  mock.failWith = new ProviderError('upstream', 'vat-vendor', 'provider is down');
  const second = await syncConnection(c, mock, store, { now: () => new Date('2026-10-22T09:00:00.000Z') });

  assert.equal(second.status, 'failed');
  assert.match(second.error!, /^upstream: provider is down/);
  assert.deepEqual(store.filingsFor(c.id), before);
  const s = store.state.get(c.id)!;
  assert.equal(s.lastSyncedAt, syncedAt, 'the "as of" time must not move on failure');
  assert.equal(s.lastStatus, 'failed');
  assert.match(s.lastError!, /provider is down/);
});

test('fetch-then-write: if filings fail to fetch, registrations are not written either', async () => {
  const store = new InMemoryStore();
  const c = connection();
  const { fetch } = fakeFetch((url) =>
    url.pathname === '/registrations' ? json(registrationsBody) : json({ error: 'down' }, 503),
  );
  const adapter = new ZampAdapter({ apiKey: 'k', fetchImpl: fetch, sleep: noSleep, maxRetries: 0 });

  const result = await syncConnection(c, adapter, store, { now: fixedNow });

  assert.equal(result.status, 'failed');
  assert.equal(store.registrations.size, 0);
  assert.equal(store.filings.size, 0);
});

test('history is never deleted: a later sync that returns fewer filings keeps the older ones', async () => {
  const store = new InMemoryStore();
  const c = connection({ providerKey: 'vat-vendor' });
  await syncConnection(c, vatMock(), store, { now: fixedNow });
  assert.equal(store.filings.size, 2);

  const shrunk = new MockAdapter({ key: 'vat-vendor', filings: [canonFiling({ externalId: 'DE:2026-Q2' })] });
  await syncConnection(c, shrunk, store, { now: fixedNow });
  assert.deepEqual(store.filingsFor(c.id), ['DE:2026-Q2', 'FR:2026-Q2']);
});

test('syncing twice is idempotent', async () => {
  const store = new InMemoryStore();
  const c = connection({ providerKey: 'vat-vendor' });
  await syncConnection(c, vatMock(), store, { now: fixedNow });
  await syncConnection(c, vatMock(), store, { now: fixedNow });
  assert.equal(store.filings.size, 2);
  assert.equal(store.registrations.size, 2);
  assert.equal(store.runs.length, 2);
});

test('one bad connection never stops the others', async () => {
  const store = new InMemoryStore();
  const good = connection({ tenantId: 'a', providerKey: 'vat-vendor' });
  const noCredential = connection({ tenantId: 'b', providerKey: 'zamp', credentialRef: 'MISSING_KEY' });
  const alsoGood = connection({ tenantId: 'c', providerKey: 'vat-vendor' });

  registerAdapter('vat-vendor', () => vatMock());
  const results = await syncAll(
    [good, noCredential, alsoGood],
    (c) => buildAdapter(c, {}), // empty environment: zamp has no credential
    store,
    { now: fixedNow },
  );

  assert.deepEqual(results.map((r) => r.status), ['succeeded', 'failed', 'succeeded']);
  assert.match(results[1]!.error ?? '', /config: Credential "MISSING_KEY" is not set/);
  assert.equal(store.filingsFor(good.id).length, 2);
  assert.equal(store.filingsFor(alsoGood.id).length, 2);
});

test('paused and disconnected connections are skipped without contacting the provider', async () => {
  const store = new InMemoryStore();
  const mock = vatMock();
  for (const status of ['paused', 'disconnected'] as const) {
    const r = await syncConnection(connection({ status }), mock, store, { now: fixedNow });
    assert.equal(r.status, 'skipped');
  }
  assert.equal(mock.calls.length, 0);
  assert.equal(store.runs.length, 0);
});

test('the client\'s provider company id is passed on every call (partner-key routing)', async () => {
  const store = new InMemoryStore();
  const mock = vatMock();
  await syncConnection(connection({ providerKey: 'vat-vendor', providerCompanyId: 'cmp_42' }), mock, store, { now: fixedNow });
  assert.ok(mock.calls.length >= 2);
  assert.ok(mock.calls.every((ctx) => ctx.providerCompanyId === 'cmp_42'));
});

test('capability flags are respected: unsupported features are never called', async () => {
  const store = new InMemoryStore();
  const mock = new MockAdapter({
    capabilities: { registrations: false },
    registrations: [canonRegistration()],
    filings: [canonFiling()],
  });
  await syncConnection(connection({ providerKey: 'mock' }), mock, store, { now: fixedNow });
  assert.equal(store.registrations.size, 0);
  assert.equal(store.filings.size, 1);
  assert.equal(mock.calls.length, 1, 'only the filings call should have been made');
});

test('the registry resolves credentials by name and rejects unknown or unconfigured providers', () => {
  const c = connection({ providerKey: 'zamp', credentialRef: 'MY_ZAMP_KEY' });
  assert.equal(buildAdapter(c, { MY_ZAMP_KEY: 'secret' }).key, 'zamp');

  const missing = (() => {
    try {
      buildAdapter(c, {});
    } catch (e) {
      return e;
    }
  })();
  assert.ok(missing instanceof ProviderError && missing.kind === 'config');

  const unknown = (() => {
    try {
      buildAdapter(connection({ providerKey: 'nobody' }), {});
    } catch (e) {
      return e;
    }
  })();
  assert.ok(unknown instanceof ProviderError && unknown.kind === 'config');
});
