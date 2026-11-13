-- Taxcart platform: the manual VAT service (clients upload sales files, Taxcart staff prepare and file the returns).
--
-- Nothing here is linked to a data provider: people move each return through six statuses and talk to the client
-- in a thread attached to the return. Clients can READ their own rows (row-level security); every change is made
-- by the backend after it has checked who is asking, so clients and anon have no write access at all.

-- 1. What each client is registered to file (the portal only offers these, and the period choices follow from them).
create table vat_registrations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  scheme      text not null check (scheme in ('uk_vat', 'ioss', 'oss', 'local_vat')),
  country     text not null check (country ~ '^[A-Z]{2}$'),        -- UK VAT: GB. IOSS/OSS: the member state of identification.
  frequency   text not null check (frequency in ('monthly', 'quarterly', 'annual')),
  vat_number  text check (vat_number is null or length(vat_number) <= 40),
  created_at  timestamptz not null default now(),
  unique (tenant_id, scheme, country)
);

-- 2. One row per return (a scheme + country + period for a client).
create table vat_returns (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  registration_id   uuid references vat_registrations(id) on delete set null,
  scheme            text not null check (scheme in ('uk_vat', 'ioss', 'oss', 'local_vat')),
  country           text not null check (country ~ '^[A-Z]{2}$'),
  period_code       text not null check (period_code ~ '^[0-9]{4}(-[0-9]{2}|-Q[1-4])?$'),
  period_start      date not null,
  period_end        date not null,
  due_on            date,
  status            text not null default 'submitted'
                    check (status in ('submitted', 'received', 'in_review', 'return_prepared', 'filed', 'complete')),
  awaiting_client   boolean not null default false,            -- staff asked a question and no reply yet
  submitted_by      uuid references auth.users(id) on delete set null,
  submitted_at      timestamptz not null default now(),
  upload_path       text,
  upload_name       text,
  upload_bytes      integer,
  upload_rows       integer,
  upload_summary    jsonb,                                      -- totals and warnings found when the file was checked
  return_path       text,
  return_name       text,
  return_bytes      integer,
  filed_at          timestamptz,
  updated_at        timestamptz not null default now(),
  unique (tenant_id, scheme, country, period_code)
);
create index vat_returns_tenant_idx on vat_returns (tenant_id, period_start desc);
create index vat_returns_status_idx on vat_returns (status, due_on);

-- 3. Everything that happens on a return: status changes, files, questions and replies.
create table vat_events (
  id           uuid primary key default gen_random_uuid(),
  return_id    uuid not null references vat_returns(id) on delete cascade,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  actor_id     uuid references auth.users(id) on delete set null,
  actor_side   text not null check (actor_side in ('client', 'staff')),
  kind         text not null check (kind in ('submitted', 'file_replaced', 'status', 'question', 'reply', 'return_attached', 'due_changed')),
  to_status    text,
  body         text check (body is null or length(body) <= 4000),
  created_at   timestamptz not null default now()
);
create index vat_events_return_idx on vat_events (return_id, created_at);

alter table vat_registrations enable row level security;
alter table vat_returns       enable row level security;
alter table vat_events        enable row level security;

create policy vat_registrations_select on vat_registrations for select to authenticated
  using (is_tenant_member(tenant_id) or is_staff());
create policy vat_returns_select on vat_returns for select to authenticated
  using (is_tenant_member(tenant_id) or is_staff());
create policy vat_events_select on vat_events for select to authenticated
  using (is_tenant_member(tenant_id) or is_staff());

revoke all on vat_registrations, vat_returns, vat_events from anon;
revoke insert, update, delete on vat_registrations, vat_returns, vat_events from authenticated;

-- 4. Private storage for uploaded sales files and finished returns. Nobody reaches it directly: the backend hands out
--    short-lived download links after checking access. (Skipped where there is no storage schema, e.g. a scratch test database.)
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('vat-files', 'vat-files', false) on conflict (id) do nothing;
  end if;
end $$;
