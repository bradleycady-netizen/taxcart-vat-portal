-- Taxcart platform: initial schema
--
-- Design rules baked in here:
--  1. Tenant isolation: every client-facing row carries tenant_id; RLS limits members to their own tenant.
--  2. White-label: clients can NEVER read which provider serves them. provider_connections and
--     sync_runs are staff-only. Client-facing tables hold provider-neutral data only.
--  3. Writes come from the backend (service role, which bypasses RLS). Clients get SELECT only.
--  4. Filing records are retained permanently: the sync engine upserts and never deletes.
--  5. Secrets never live in the database. credential_ref is the NAME of an environment variable.
--
-- Requires Supabase's built-in auth schema (auth.users, auth.uid(), auth.jwt()).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums
create type product_key as enum ('us_sales_tax', 'eu_vat');
create type connection_status as enum ('active', 'paused', 'disconnected');
create type sync_status as enum ('running', 'succeeded', 'failed');
create type member_role as enum ('owner', 'member');
create type filing_frequency as enum ('monthly', 'quarterly', 'semi_annual', 'annual', 'other');

-- ---------------------------------------------------------------- helpers
-- Taxcart staff are marked with app_metadata.taxcart_staff = true on their auth user
-- (settable only via the service role / dashboard, never by the user).
create or replace function is_staff() returns boolean
language sql stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'taxcart_staff')::boolean, false)
$$;

-- ---------------------------------------------------------------- tenants
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table tenant_members (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        member_role not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on tenant_members(user_id);

-- Membership check used by every client-facing policy. SECURITY DEFINER so that policies on
-- tenant_members itself cannot recurse.
create or replace function is_tenant_member(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from tenant_members
    where tenant_id = p_tenant and user_id = auth.uid()
  )
$$;

-- ---------------------------------------------------------------- provider connections (staff-only)
-- One ACTIVE connection per tenant per product. Switching providers = pause/disconnect the old
-- row and insert a new one. Different products can use different providers concurrently.
create table provider_connections (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  product              product_key not null,
  provider_key         text not null,                 -- e.g. 'zamp', 'mock', your VAT vendor
  provider_company_id  text,                          -- the provider's ID for this client (partner key use)
  credential_ref       text not null,                 -- NAME of an env var, never the secret
  status               connection_status not null default 'active',
  last_synced_at       timestamptz,
  last_sync_status     sync_status,
  last_sync_error      text,
  created_at           timestamptz not null default now()
);
create unique index provider_connections_one_active
  on provider_connections(tenant_id, product) where status = 'active';
create index provider_connections_tenant_idx on provider_connections(tenant_id);

-- ---------------------------------------------------------------- synced data (client-readable)
create table registrations (
  id                  uuid primary key default gen_random_uuid(),
  connection_id       uuid not null references provider_connections(id) on delete restrict,
  tenant_id           uuid not null references tenants(id) on delete cascade,
  jurisdiction        text not null,                  -- US state code, EU country code, etc.
  tax_id              text,
  started_at          date not null,
  ended_at            date,
  frequency           filing_frequency,
  raw_frequency_code  text,                           -- provider's own code, kept for fidelity
  synced_at           timestamptz not null default now(),
  unique (connection_id, jurisdiction, started_at)
);
create index registrations_tenant_idx on registrations(tenant_id);

create table filings (
  id                    uuid primary key default gen_random_uuid(),
  connection_id         uuid not null references provider_connections(id) on delete restrict,
  tenant_id             uuid not null references tenants(id) on delete cascade,
  external_id           text not null,                -- provider-side identity, e.g. 'KS:2025-JAN'
  jurisdiction          text not null,
  period_code           text not null,
  period_name           text not null,
  frequency             filing_frequency,
  raw_frequency_code    text,
  due_on                date not null,
  is_completed          boolean not null default false,
  estimated_tax_due     numeric(14,2),
  return_confirmation   text,
  payment_confirmation  text,
  amount_paid           numeric(14,2),
  documents             jsonb not null default '[]',  -- [{ "kind": "return" }, ...]; NEVER store signed URLs
  synced_at             timestamptz not null default now(),
  unique (connection_id, external_id)
);
create index filings_tenant_due_idx on filings(tenant_id, due_on desc);

-- ---------------------------------------------------------------- operations (staff-only)
create table sync_runs (
  id                      uuid primary key default gen_random_uuid(),
  connection_id           uuid not null references provider_connections(id) on delete cascade,
  started_at              timestamptz not null default now(),
  finished_at             timestamptz,
  status                  sync_status not null default 'running',
  registrations_upserted  integer not null default 0,
  filings_upserted        integer not null default 0,
  error                   text
);
create index sync_runs_connection_idx on sync_runs(connection_id, started_at desc);

-- Insert-only trail of sensitive actions (e.g. document downloads, staff access).
create table audit_log (
  id          bigint generated always as identity primary key,
  tenant_id   uuid references tenants(id) on delete set null,
  actor_id    uuid,
  action      text not null,
  target      text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_tenant_idx on audit_log(tenant_id, created_at desc);

-- ---------------------------------------------------------------- row-level security
alter table tenants              enable row level security;
alter table tenant_members       enable row level security;
alter table provider_connections enable row level security;
alter table registrations        enable row level security;
alter table filings              enable row level security;
alter table sync_runs            enable row level security;
alter table audit_log            enable row level security;

-- Clients (read-only, own tenant)
create policy tenants_select on tenants
  for select to authenticated
  using (is_tenant_member(id) or is_staff());

create policy tenant_members_select on tenant_members
  for select to authenticated
  using (user_id = auth.uid() or is_staff());

create policy registrations_select on registrations
  for select to authenticated
  using (is_tenant_member(tenant_id) or is_staff());

create policy filings_select on filings
  for select to authenticated
  using (is_tenant_member(tenant_id) or is_staff());

-- Staff only (white-label: clients must not see provider identity or sync internals)
create policy provider_connections_staff on provider_connections
  for select to authenticated
  using (is_staff());

create policy sync_runs_staff on sync_runs
  for select to authenticated
  using (is_staff());

create policy audit_log_staff on audit_log
  for select to authenticated
  using (is_staff());

-- No INSERT/UPDATE/DELETE policies exist for the 'authenticated' role, so those are denied.
-- The backend uses the service-role key, which bypasses RLS, for all writes.

-- Defence in depth: revoke write privileges outright for client-facing roles.
revoke insert, update, delete on
  tenants, tenant_members, provider_connections, registrations, filings, sync_runs, audit_log
from authenticated, anon;
revoke all on provider_connections, sync_runs, audit_log from anon;
