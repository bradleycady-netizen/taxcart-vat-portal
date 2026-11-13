-- Minimal stand-in for the parts of Supabase the migration depends on, so the schema and its
-- row-level security can be tested on a plain local Postgres. NOT for use on a real Supabase project
-- (which already provides all of this).

-- Roles are cluster-wide and survive dropping the test database, so create them only if missing.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(current_setting('request.jwt.claim.sub', true),
             current_setting('request.jwt.claims', true)::jsonb ->> 'sub'),
    '')::uuid
$$;

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase grants broad default privileges on public tables; replicate that so the migration's own
-- REVOKEs and RLS are what actually protect the data (the realistic situation).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
