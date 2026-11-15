import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/providers/mock/adapter.ts';
import { runScheduledSync, type ConnectionSource } from '../src/sync/runner.ts';
import { SupabaseConnectionSource, connectionFromRow } from '../src/sync/supabaseSource.ts';
import { SupabaseStore } from '../src/sync/supabaseStore.ts';
import { AlreadyRunningError, syncAll, syncConnection } from '../src/sync/sync.ts';
import type { ProviderAdapter, ProviderConnection } from '../src/core/types.ts';
import { InMemoryStore, canonFiling, canonRegistration, connection, fakeSupabase } from './helpers.ts';

const fixedNow = () => new Date('2026-10-22T03:00:00.000Z');

function source(connections: ProviderConnection[], over: Partial<ConnectionSource> = {}): ConnectionSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listActive: async () => (calls.push('listActive'), connections),
    getActive: async (id) => (calls.push(`getActive:${id}`), connections.find((c) => c.id === id) ?? null),
    reapStale: async () => (calls.push('reapStale'), 0),
    purgeThrottle: async () => (calls.push('purgeThrottle'), 0),
    ...over,
  };
}

const mockWith = (n = 1) =>
  new MockAdapter({
    key: 'vat-vendor',
    registrations: [canonRegistration()],
    filings: Array.from({ length: n }, (_, i) => canonFiling({ externalId: `DE:${i}` })),
  });

test('a run reaps crashed syncs first, syncs everything, then does housekeeping', async () => {
  const store = new InMemoryStore();
  const cs = [connection({ providerKey: 'vat-vendor' }), connection({ providerKey: 'vat-vendor' })];
  const src = source(cs, { reapStale: async () => (src.calls.push('reapStale'), 2) });

  const summary = await runScheduledSync(src, store, () => mockWith(), { budgetMs: 10_000, now: fixedNow });

  assert.deepEqual(src.calls, ['reapStale', 'listActive', 'purgeThrottle']);
  assert.equal(summary.reaped, 2);
  assert.equal(summary.total, 2);
  assert.equal(summary.succeeded, 2);
  assert.equal(store.filings.size, 2);
});

test('the time budget stops new connections from starting; the rest are deferred, untouched', async () => {
  let clock = 0;
  const store = new InMemoryStore();
  const cs = [1, 2, 3, 4, 5].map(() => connection({ providerKey: 'vat-vendor' }));
  const touched: string[] = [];
  const resolve = (c: ProviderConnection): ProviderAdapter => {
    const a = mockWith();
    const original = a.listRegistrations.bind(a);
    a.listRegistrations = async (ctx) => {
      touched.push(c.id);
      clock += 20_000; // each sync "takes" 20 seconds
      return original(ctx);
    };
    return a;
  };

  const summary = await runScheduledSync(source(cs), store, resolve, {
    budgetMs: 50_000,
    concurrency: 1,
    nowMs: () => clock,
    now: fixedNow,
  });

  // Starts at 0s, 20s, 40s (all inside the 50s budget); at 60s the budget is spent.
  assert.equal(summary.succeeded, 3);
  assert.equal(summary.deferred, 2);
  assert.deepEqual(touched, [cs[0]!.id, cs[1]!.id, cs[2]!.id]);
  assert.deepEqual(summary.results.map((r) => r.status), ['succeeded', 'succeeded', 'succeeded', 'deferred', 'deferred']);
  assert.equal(store.runs.length, 3, 'deferred connections must not even open a run');
});

test('connections are processed in the order the source returns them (stalest first)', async () => {
  const order: string[] = [];
  const cs = [connection({ providerKey: 'vat-vendor' }), connection({ providerKey: 'vat-vendor' }), connection({ providerKey: 'vat-vendor' })];
  await runScheduledSync(
    source(cs),
    new InMemoryStore(),
    (c) => {
      const a = mockWith();
      const original = a.listRegistrations.bind(a);
      a.listRegistrations = async (ctx) => (order.push(c.id), original(ctx));
      return a;
    },
    { budgetMs: 10_000, concurrency: 1, now: fixedNow },
  );
  assert.deepEqual(order, cs.map((c) => c.id));
});

test('a sync already in progress is skipped quietly, not reported as a failure', async () => {
  const store = new InMemoryStore();
  const c = connection({ providerKey: 'vat-vendor' });
  await store.startRun(c); // someone else's run is still open

  const summary = await runScheduledSync(source([c]), store, () => mockWith(), { budgetMs: 10_000, now: fixedNow });

  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.results[0]!.error, 'already running');
  assert.equal(store.filings.size, 0, 'the skipped sync must not write anything');
});

test('two overlapping syncs of one connection: exactly one runs', async () => {
  const store = new InMemoryStore();
  const c = connection({ providerKey: 'vat-vendor' });
  const slow = mockWith();
  const original = slow.listRegistrations.bind(slow);
  slow.listRegistrations = async (ctx) => (await new Promise((r) => setTimeout(r, 20)), original(ctx));

  const [a, b] = await Promise.all([
    syncConnection(c, slow, store, { now: fixedNow }),
    syncConnection(c, slow, store, { now: fixedNow }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['skipped', 'succeeded']);
});

test('housekeeping failures are logged but never stop the sync', async () => {
  const events: string[] = [];
  const store = new InMemoryStore();
  const src = source([connection({ providerKey: 'vat-vendor' })], {
    reapStale: async () => { throw new Error('db hiccup'); },
    purgeThrottle: async () => { throw new Error('db hiccup'); },
  });
  const summary = await runScheduledSync(src, store, () => mockWith(), {
    budgetMs: 10_000,
    now: fixedNow,
    log: (e) => void events.push(e),
  });
  assert.equal(summary.succeeded, 1);
  assert.ok(events.includes('sync.reap_failed') && events.includes('sync.purge_throttle_failed'));
});

test('a manual single-connection run syncs only that one', async () => {
  const store = new InMemoryStore();
  const cs = [connection({ providerKey: 'vat-vendor' }), connection({ providerKey: 'vat-vendor' })];
  const src = source(cs);
  const summary = await runScheduledSync(src, store, () => mockWith(), { budgetMs: 10_000, onlyConnectionId: cs[1]!.id, now: fixedNow });
  assert.equal(summary.total, 1);
  assert.equal(summary.results[0]!.connectionId, cs[1]!.id);
  assert.ok(src.calls.includes(`getActive:${cs[1]!.id}`) && !src.calls.includes('listActive'));

  const none = await runScheduledSync(source(cs), store, () => mockWith(), { budgetMs: 10_000, onlyConnectionId: 'nope', now: fixedNow });
  assert.equal(none.total, 0);
});

test('an unusable credential on one connection does not block the rest of the run', async () => {
  const store = new InMemoryStore();
  const bad = connection({ providerKey: 'vat-vendor' });
  const good = connection({ providerKey: 'vat-vendor' });
  const summary = await runScheduledSync(
    source([bad, good]),
    store,
    (c) => {
      if (c.id === bad.id) throw new Error('no credential');
      return mockWith();
    },
    { budgetMs: 10_000, now: fixedNow },
  );
  assert.deepEqual(summary.results.map((r) => r.status), ['failed', 'succeeded']);
});

test('syncAll marks everything deferred once shouldStop is true', async () => {
  const store = new InMemoryStore();
  const cs = [connection({ providerKey: 'vat-vendor' }), connection({ providerKey: 'vat-vendor' })];
  const results = await syncAll(cs, () => mockWith(), store, { shouldStop: () => true, now: fixedNow });
  assert.deepEqual(results.map((r) => r.status), ['deferred', 'deferred']);
  assert.equal(store.runs.length, 0);
});

// ------------------------------------------------------------------ Supabase-backed pieces

test('SupabaseStore.startRun turns the one-running-sync violation into AlreadyRunningError', async () => {
  const dup = fakeSupabase('sync_runs', '23505');
  await assert.rejects(new SupabaseStore(dup.db).startRun(connection()), (e: unknown) => e instanceof AlreadyRunningError);

  const other = fakeSupabase('sync_runs', '42501');
  await assert.rejects(
    new SupabaseStore(other.db).startRun(connection()),
    (e: unknown) => e instanceof Error && !(e instanceof AlreadyRunningError) && /startRun failed/.test(e.message),
  );
});

test('connectionFromRow maps database columns to a ProviderConnection', () => {
  assert.deepEqual(
    connectionFromRow({
      id: 'c1', tenant_id: 't1', product: 'eu_vat', provider_key: 'vat-vendor',
      provider_company_id: null, credential_ref: 'VAT_KEY', status: 'active',
    }),
    { id: 'c1', tenantId: 't1', product: 'eu_vat', providerKey: 'vat-vendor', providerCompanyId: null, credentialRef: 'VAT_KEY', credentialEnc: null, status: 'active' },
  );
  assert.equal(
    connectionFromRow({ id: 'c2', tenant_id: 't1', product: 'us_sales_tax', provider_key: 'zamp', provider_company_id: null, credential_ref: null, credential_enc: 'v1.a.b.c', status: 'active' }).credentialEnc,
    'v1.a.b.c',
  );
});

test('SupabaseConnectionSource asks for active connections stalest-first, and calls the cleanup functions', async () => {
  const seen: Record<string, unknown>[] = [];
  const row = { id: 'c1', tenant_id: 't1', product: 'us_sales_tax', provider_key: 'zamp', provider_company_id: 'z1', credential_ref: 'K', status: 'active' };
  const builder = (data: unknown) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) b[m] = (...a: unknown[]) => (seen.push({ m, a }), b);
    b['order'] = (...a: unknown[]) => (seen.push({ m: 'order', a }), Promise.resolve({ data, error: null }));
    b['maybeSingle'] = () => Promise.resolve({ data: data && (data as unknown[])[0], error: null });
    return b;
  };
  const db = {
    from: (t: string) => (seen.push({ m: 'from', a: [t] }), builder([row])),
    rpc: async (fn: string, args: unknown) => (seen.push({ m: 'rpc', a: [fn, args] }), { data: 3, error: null }),
  } as never;

  const src = new SupabaseConnectionSource(db);
  const list = await src.listActive();
  assert.equal(list[0]!.providerKey, 'zamp');
  assert.deepEqual(seen.find((s) => s['m'] === 'order')!['a'], ['last_synced_at', { ascending: true, nullsFirst: true }]);
  assert.deepEqual(seen.find((s) => s['m'] === 'eq')!['a'], ['status', 'active']);

  assert.equal(await src.reapStale(), 3);
  assert.equal(await src.purgeThrottle(), 3);
  const rpcs = seen.filter((s) => s['m'] === 'rpc').map((s) => (s['a'] as unknown[])[0]);
  assert.deepEqual(rpcs, ['reap_stale_sync_runs', 'purge_auth_throttle']);
});
