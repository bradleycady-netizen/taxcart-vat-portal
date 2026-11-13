-- Taxcart platform: sync locking, crashed-run recovery, and login throttling.
--
--  1. Only ONE sync may be running per connection, so overlapping cron invocations (or a manual
--     sync during a scheduled one) cannot step on each other.
--  2. A function that marks crashed runs (function timed out, process killed) as failed, so a dead
--     'running' row can never block a connection forever.
--  3. A small throttle used by the login endpoints to slow down code guessing and email flooding.
--     State lives in the database because serverless functions share no memory.
--
-- Everything here is callable by the backend (service role) only.

-- ---------------------------------------------------------------- 1. one running sync per connection
create unique index sync_runs_one_running
  on sync_runs(connection_id) where status = 'running';

-- ---------------------------------------------------------------- 2. reap crashed runs
create or replace function reap_stale_sync_runs(p_max_age interval default interval '15 minutes')
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  reaped integer;
begin
  with stale as (
    update sync_runs
       set status = 'failed',
           finished_at = now(),
           error = 'timed out: run never finished and was reaped'
     where status = 'running'
       and started_at < now() - p_max_age
    returning connection_id
  )
  update provider_connections c
     set last_sync_status = 'failed',
         last_sync_error  = 'timed out: run never finished and was reaped'
    from stale
   where c.id = stale.connection_id;

  get diagnostics reaped = row_count;
  return reaped;
end $$;

-- ---------------------------------------------------------------- 3. login throttle
create table auth_throttle (
  id          bigint generated always as identity primary key,
  bucket      text not null,                 -- an HMAC of the thing being limited, never a raw email or IP
  created_at  timestamptz not null default now()
);
create index auth_throttle_bucket_idx on auth_throttle(bucket, created_at desc);

alter table auth_throttle enable row level security;   -- no policies: nobody but the service role
revoke all on auth_throttle from anon, authenticated;

-- Records one attempt and says whether it is allowed. Blocked attempts are NOT recorded, so a
-- persistent attacker cannot extend a lockout beyond the window.
create or replace function auth_throttle_hit(p_bucket text, p_limit integer, p_window interval)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_bucket, 0));   -- serialise attempts on one bucket
  delete from auth_throttle where bucket = p_bucket and created_at < now() - p_window;
  select count(*) into n from auth_throttle where bucket = p_bucket;
  if n >= p_limit then
    return false;
  end if;
  insert into auth_throttle(bucket) values (p_bucket);
  return true;
end $$;

-- Forget a bucket (used after a successful login so a typo earlier does not lock the person out).
create or replace function auth_throttle_reset(p_bucket text) returns void
language sql security definer
set search_path = public
as $$
  delete from auth_throttle where bucket = p_bucket
$$;

-- Housekeeping for buckets that were never touched again.
create or replace function purge_auth_throttle(p_older_than interval default interval '1 day')
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from auth_throttle where created_at < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- privileges: service role only
revoke all on function reap_stale_sync_runs(interval)        from public, anon, authenticated;
revoke all on function auth_throttle_hit(text, integer, interval) from public, anon, authenticated;
revoke all on function auth_throttle_reset(text)             from public, anon, authenticated;
revoke all on function purge_auth_throttle(interval)         from public, anon, authenticated;

grant execute on function reap_stale_sync_runs(interval)        to service_role;
grant execute on function auth_throttle_hit(text, integer, interval) to service_role;
grant execute on function auth_throttle_reset(text)             to service_role;
grant execute on function purge_auth_throttle(interval)         to service_role;
