-- Checks for migration 0002: sync locking, stale-run reaper, login throttle, and who may call what.
-- Runs after 0001, 0002 and rls_checks.sql on the same scratch database.

-- ------------------------------------------------------------ fixtures
insert into tenants(id, name) values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Ops Tenant');
insert into provider_connections(id, tenant_id, product, provider_key, credential_ref, last_synced_at) values
  ('d0000000-0000-0000-0000-000000000001', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'us_sales_tax', 'zamp', 'K',
   '2026-01-01T00:00:00Z');

-- ------------------------------------------------------------ one running sync per connection
do $$ begin
  insert into sync_runs(connection_id, status) values ('d0000000-0000-0000-0000-000000000001', 'running');

  begin
    insert into sync_runs(connection_id, status) values ('d0000000-0000-0000-0000-000000000001', 'running');
    raise exception 'a second running sync for the same connection should be rejected';
  exception when unique_violation then null; end;

  -- finished runs do not block, and history may hold many of them
  update sync_runs set status = 'succeeded', finished_at = now()
   where connection_id = 'd0000000-0000-0000-0000-000000000001';
  insert into sync_runs(connection_id, status) values ('d0000000-0000-0000-0000-000000000001', 'running');
  update sync_runs set status = 'failed', finished_at = now()
   where connection_id = 'd0000000-0000-0000-0000-000000000001' and status = 'running';
  assert (select count(*) from sync_runs where connection_id = 'd0000000-0000-0000-0000-000000000001') = 2,
    'finished runs should be kept as history';
end $$;

-- ------------------------------------------------------------ reaper
do $$
declare reaped integer;
begin
  -- a crashed run (20 minutes old) and a healthy fresh one on a different connection
  insert into provider_connections(id, tenant_id, product, provider_key, credential_ref) values
    ('d0000000-0000-0000-0000-000000000002', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'eu_vat', 'vat-vendor', 'K2');
  insert into sync_runs(connection_id, status, started_at)
    values ('d0000000-0000-0000-0000-000000000001', 'running', now() - interval '20 minutes');
  insert into sync_runs(connection_id, status, started_at)
    values ('d0000000-0000-0000-0000-000000000002', 'running', now() - interval '1 minute');

  reaped := reap_stale_sync_runs(interval '15 minutes');
  assert reaped = 1, 'exactly one stale run should be reaped, got ' || reaped;

  assert (select status from sync_runs where connection_id = 'd0000000-0000-0000-0000-000000000001' and error is not null) = 'failed',
    'the stale run should be marked failed';
  assert (select count(*) from sync_runs where connection_id = 'd0000000-0000-0000-0000-000000000002' and status = 'running') = 1,
    'a fresh run must be left alone';

  -- the connection reports the failure but its "as of" time does not move
  assert (select last_sync_status from provider_connections where id = 'd0000000-0000-0000-0000-000000000001') = 'failed',
    'connection should show the failed sync';
  assert (select last_synced_at from provider_connections where id = 'd0000000-0000-0000-0000-000000000001') = '2026-01-01T00:00:00Z',
    'reaping must not advance last_synced_at';

  -- and the connection is unblocked
  insert into sync_runs(connection_id, status) values ('d0000000-0000-0000-0000-000000000001', 'running');
end $$;

-- ------------------------------------------------------------ throttle
do $$ begin
  assert auth_throttle_hit('b1', 3, interval '15 minutes'), 'attempt 1 allowed';
  assert auth_throttle_hit('b1', 3, interval '15 minutes'), 'attempt 2 allowed';
  assert auth_throttle_hit('b1', 3, interval '15 minutes'), 'attempt 3 allowed';
  assert not auth_throttle_hit('b1', 3, interval '15 minutes'), 'attempt 4 must be blocked';
  assert not auth_throttle_hit('b1', 3, interval '15 minutes'), 'attempt 5 must still be blocked';
  assert (select count(*) from auth_throttle where bucket = 'b1') = 3, 'blocked attempts must not be recorded';

  assert auth_throttle_hit('b2', 3, interval '15 minutes'), 'another bucket is independent';

  -- attempts older than the window stop counting
  insert into auth_throttle(bucket, created_at) values ('b3', now() - interval '20 minutes'), ('b3', now() - interval '20 minutes'),
                                                        ('b3', now() - interval '20 minutes');
  assert auth_throttle_hit('b3', 3, interval '15 minutes'), 'old attempts must age out of the window';
  assert (select count(*) from auth_throttle where bucket = 'b3') = 1, 'expired rows should be cleaned up';

  -- reset forgets a bucket
  perform auth_throttle_reset('b1');
  assert auth_throttle_hit('b1', 3, interval '15 minutes'), 'bucket should work again after reset';

  -- purge removes abandoned old rows only
  insert into auth_throttle(bucket, created_at) values ('old', now() - interval '3 days');
  assert purge_auth_throttle(interval '1 day') = 1, 'purge should remove exactly the one old row';
  assert (select count(*) from auth_throttle where bucket = 'b2') = 1, 'purge must keep recent rows';
end $$;

-- ------------------------------------------------------------ nobody but the service role may touch any of this
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', false);
do $$ begin
  begin perform auth_throttle_hit('x', 1, interval '1 minute'); raise exception 'authenticated must not call auth_throttle_hit';
  exception when insufficient_privilege then null; end;
  begin perform reap_stale_sync_runs(); raise exception 'authenticated must not call reap_stale_sync_runs';
  exception when insufficient_privilege then null; end;
  begin perform purge_auth_throttle(); raise exception 'authenticated must not call purge_auth_throttle';
  exception when insufficient_privilege then null; end;
  begin perform auth_throttle_reset('b2'); raise exception 'authenticated must not call auth_throttle_reset';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from auth_throttle; raise exception 'authenticated must not read auth_throttle';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set role anon;
do $$ begin
  begin perform auth_throttle_hit('x', 1, interval '1 minute'); raise exception 'anon must not call auth_throttle_hit';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from auth_throttle; raise exception 'anon must not read auth_throttle';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set role service_role;
do $$ begin
  assert auth_throttle_hit('svc', 1, interval '1 minute'), 'service role may call the throttle';
  assert reap_stale_sync_runs() >= 0, 'service role may call the reaper';
end $$;
reset role;

\echo 'ALL OPS CHECKS PASSED'
