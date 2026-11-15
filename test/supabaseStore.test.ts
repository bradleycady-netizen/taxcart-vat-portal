import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStore } from '../src/sync/supabaseStore.ts';
import { canonFiling, canonRegistration, connection, fakeSupabase } from './helpers.ts';

test('filings are upserted on their natural key, tagged with the tenant, with no links stored', async () => {
  const { db, log } = fakeSupabase();
  const c = connection({ tenantId: 'tenant-x' });
  await new SupabaseStore(db).upsertFilings(c, [canonFiling()], '2026-10-22T03:00:00.000Z');

  assert.equal(log.length, 1);
  assert.equal(log[0]!.table, 'filings');
  assert.equal(log[0]!.onConflict, 'connection_id,external_id');
  const row = (log[0]!.payload as Record<string, unknown>[])[0]!;
  assert.equal(row['tenant_id'], 'tenant-x');
  assert.equal(row['connection_id'], c.id);
  assert.deepEqual(row['documents'], [{ kind: 'return' }]);
  assert.ok(!JSON.stringify(row).includes('http'));
});

test('registrations are upserted on (connection, jurisdiction, start date)', async () => {
  const { db, log } = fakeSupabase();
  await new SupabaseStore(db).upsertRegistrations(connection(), [canonRegistration()], '2026-10-22T03:00:00.000Z');
  assert.equal(log[0]!.table, 'registrations');
  assert.equal(log[0]!.onConflict, 'connection_id,jurisdiction,started_at');
});

test('large batches are split into chunks', async () => {
  const { db, log } = fakeSupabase();
  const rows = Array.from({ length: 1200 }, (_, i) => canonFiling({ externalId: `DE:${i}` }));
  const n = await new SupabaseStore(db).upsertFilings(connection(), rows, '2026-10-22T03:00:00.000Z');
  assert.equal(n, 1200);
  assert.deepEqual(log.map((l) => (l.payload as unknown[]).length), [500, 500, 200]);
});

test('last_synced_at advances only on success', async () => {
  const c = connection();

  const ok = fakeSupabase();
  await new SupabaseStore(ok.db).finishRun(c, 'run-1', {
    status: 'succeeded', registrations: 1, filings: 2, error: null, finishedAt: '2026-10-22T03:00:00.000Z',
  });
  const okPatch = ok.log.find((l) => l.table === 'provider_connections')!.payload as Record<string, unknown>;
  assert.equal(okPatch['last_synced_at'], '2026-10-22T03:00:00.000Z');
  assert.equal(okPatch['last_sync_status'], 'succeeded');

  const bad = fakeSupabase();
  await new SupabaseStore(bad.db).finishRun(c, 'run-2', {
    status: 'failed', registrations: 0, filings: 0, error: 'upstream: down', finishedAt: '2026-10-22T09:00:00.000Z',
  });
  const badPatch = bad.log.find((l) => l.table === 'provider_connections')!.payload as Record<string, unknown>;
  assert.equal('last_synced_at' in badPatch, false, 'a failed sync must not move the "as of" time');
  assert.equal(badPatch['last_sync_error'], 'upstream: down');
  assert.deepEqual(bad.log.find((l) => l.table === 'provider_connections')!.filter, ['id', c.id]);
});

test('database errors surface instead of being swallowed', async () => {
  const { db } = fakeSupabase('filings');
  await assert.rejects(new SupabaseStore(db).upsertFilings(connection(), [canonFiling()], 'now'), /upsert into filings failed: boom/);
  const run = fakeSupabase('sync_runs');
  await assert.rejects(new SupabaseStore(run.db).startRun(connection()), /startRun failed/);
});
