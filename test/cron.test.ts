import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/providers/mock/adapter.ts';
import { handleSyncCron, type CronDeps } from '../src/http/handlers/cron.ts';
import type { ConnectionSource } from '../src/sync/runner.ts';
import { InMemoryStore, canonFiling, canonRegistration, connection } from './helpers.ts';
import { TEST_ENV, body, testConfig } from './httpHelpers.ts';

const SECRET = TEST_ENV.CRON_SECRET;

function setup(over: { secret?: string; connections?: ReturnType<typeof connection>[] } = {}) {
  const connections = over.connections ?? [connection({ providerKey: 'vat-vendor' }), connection({ providerKey: 'vat-vendor' })];
  const calls: string[] = [];
  const source: ConnectionSource = {
    listActive: async () => (calls.push('listActive'), connections),
    getActive: async (id) => (calls.push(`getActive:${id}`), connections.find((c) => c.id === id) ?? null),
    reapStale: async () => (calls.push('reapStale'), 0),
    purgeThrottle: async () => (calls.push('purgeThrottle'), 0),
  };
  const store = new InMemoryStore();
  const deps: CronDeps = {
    config: testConfig(over.secret === undefined ? {} : { CRON_SECRET: over.secret }),
    source,
    store,
    resolveAdapter: () => new MockAdapter({ key: 'vat-vendor', registrations: [canonRegistration()], filings: [canonFiling()] }),
    log: () => {},
    now: () => new Date('2026-10-22T03:00:00.000Z'),
  };
  return { deps, calls, store, connections };
}

const req = (method = 'GET', path = '/api/cron/sync', auth: string | null = `Bearer ${SECRET}`) =>
  new Request(`https://portal.example.com${path}`, { method, headers: auth === null ? {} : { authorization: auth } });

test('without the secret nothing runs', async () => {
  for (const auth of [null, '', 'Bearer wrong', `Bearer ${SECRET}x`, SECRET, `bearer ${SECRET}`]) {
    const s = setup();
    const res = await handleSyncCron(req('GET', '/api/cron/sync', auth), s.deps);
    assert.equal(res.status, 401, String(auth));
    assert.deepEqual(s.calls, [], 'the runner must not even look up connections');
    assert.equal(s.store.runs.length, 0);
  }
});

test('with no secret configured the endpoint is switched off, even for a request that guesses a blank secret', async () => {
  const s = setup({ secret: '' });
  assert.equal((await handleSyncCron(req('GET', '/api/cron/sync', 'Bearer '), s.deps)).status, 503);
  assert.equal((await handleSyncCron(req('GET', '/api/cron/sync', null), s.deps)).status, 503);
  assert.deepEqual(s.calls, []);
});

test('the scheduler (GET) and a manual call (POST) both run a full sync and report counts', async () => {
  for (const method of ['GET', 'POST']) {
    const s = setup();
    const res = await handleSyncCron(req(method), s.deps);
    assert.equal(res.status, 200);
    const data = await body(res);
    assert.equal(data['ok'], true);
    assert.deepEqual({ total: data['summary'].total, succeeded: data['summary'].succeeded, failed: data['summary'].failed }, { total: 2, succeeded: 2, failed: 0 });
    assert.deepEqual(data['failures'], []);
    assert.equal(s.store.filings.size, 2);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  }
});

test('other methods are refused', async () => {
  const s = setup();
  assert.equal((await handleSyncCron(req('DELETE'), s.deps)).status, 405);
  assert.deepEqual(s.calls, []);
});

test('failed connections are listed, but the run itself still answers 200 so the scheduler does not retry', async () => {
  const s = setup();
  s.deps.resolveAdapter = (c) => {
    if (c.id === s.connections[0]!.id) throw new Error('no credential');
    return new MockAdapter({ key: 'vat-vendor', filings: [canonFiling()] });
  };
  const res = await handleSyncCron(req(), s.deps);
  assert.equal(res.status, 200);
  const data = await body(res);
  assert.equal(data['summary'].failed, 1);
  assert.deepEqual(data['failures'].map((f: any) => f.connectionId), [s.connections[0]!.id]);
});

test('?connection= syncs just that connection, and must be a UUID', async () => {
  const real = [
    connection({ id: 'c0000000-0000-4000-8000-000000000001', providerKey: 'vat-vendor' }),
    connection({ id: 'c0000000-0000-4000-8000-000000000002', providerKey: 'vat-vendor' }),
  ];
  const s = setup({ connections: real });
  const res = await handleSyncCron(req('POST', `/api/cron/sync?connection=${real[1]!.id}`), s.deps);
  assert.equal((await body(res))['summary'].total, 1);
  assert.ok(s.calls.includes(`getActive:${real[1]!.id}`) && !s.calls.includes('listActive'));

  const bad = setup();
  assert.equal((await handleSyncCron(req('POST', '/api/cron/sync?connection=../../etc'), bad.deps)).status, 400);
  assert.deepEqual(bad.calls, []);
});

test('a database failure while loading connections is a generic 500, not a leak', async () => {
  const s = setup();
  s.deps.source.listActive = async () => { throw new Error('connection string postgres://user:pw@host/db refused'); };
  const res = await handleSyncCron(req(), s.deps);
  assert.equal(res.status, 500);
  assert.ok(!/postgres|pw@/.test(await res.text()));
});
