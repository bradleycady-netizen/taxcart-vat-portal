-- Checks for migration 0003 (tenant_products): clients see their own subscriptions, and nothing that
-- identifies the vendor. Uses its own fixtures so it does not depend on the other check files.

\set uV     '44444444-4444-4444-4444-444444444444'
\set uW     '55555555-5555-5555-5555-555555555555'
\set uS     '66666666-6666-6666-6666-666666666666'
\set tV     'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
\set tW     'ffffffff-ffff-ffff-ffff-ffffffffffff'

insert into auth.users(id, email) values (:'uV','v@x.test'), (:'uW','w@x.test'), (:'uS','s@x.test');
insert into tenants(id, name) values (:'tV','View Tenant V'), (:'tW','View Tenant W');
insert into tenant_members(tenant_id, user_id) values (:'tV', :'uV'), (:'tW', :'uW');

insert into provider_connections(id, tenant_id, product, provider_key, provider_company_id, credential_ref,
                                 status, last_synced_at, last_sync_status, last_sync_error) values
  ('e0000000-0000-0000-0000-000000000001', :'tV', 'us_sales_tax', 'secret-vendor-1', 'SECRET-COMPANY-1', 'SECRET_REF_1',
   'paused', '2026-01-01T00:00:00Z', 'succeeded', null),
  ('e0000000-0000-0000-0000-000000000002', :'tV', 'us_sales_tax', 'secret-vendor-2', 'SECRET-COMPANY-2', 'SECRET_REF_2',
   'active', '2026-10-01T00:00:00Z', 'failed', 'upstream: secret vendor error text'),
  ('e0000000-0000-0000-0000-000000000003', :'tV', 'eu_vat', 'secret-vendor-3', null, 'SECRET_REF_3',
   'active', null, null, null),
  ('f0000000-0000-0000-0000-000000000001', :'tW', 'us_sales_tax', 'secret-vendor-1', 'SECRET-COMPANY-9', 'SECRET_REF_9',
   'active', '2026-10-02T00:00:00Z', 'succeeded', null);

-- ------------------------------------------------------------ the view exposes only these columns
do $$ begin
  assert (select array_agg(column_name::text order by ordinal_position)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'tenant_products')
         = array['connection_id','tenant_id','product','is_active','last_synced_at','last_sync_status'],
    'tenant_products must expose exactly the six client-safe columns';
end $$;

-- ------------------------------------------------------------ client V sees only its own, with no vendor detail
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'uV')::text, false);
do $$
declare
  dump text;
begin
  assert (select count(*) from tenant_products) = 3, 'client V should see its 3 connections';
  assert (select count(*) from tenant_products where tenant_id <> 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') = 0,
    'client V must not see another tenant''s products';
  assert (select count(*) from tenant_products where product = 'us_sales_tax') = 2, 'both US connections (old + current) visible';
  assert (select count(*) from tenant_products where product = 'us_sales_tax' and is_active) = 1, 'exactly one current US connection';
  assert (select last_sync_status from tenant_products where connection_id = 'e0000000-0000-0000-0000-000000000002') = 'failed',
    'sync status is visible so the portal can show an out-of-date note';

  -- nothing identifying the vendor appears anywhere in the rows
  select string_agg(t::text, ' ') into dump from tenant_products t;
  assert dump not ilike '%secret%', 'vendor identity or error text leaked through the view: ' || dump;

  -- asking for a base-table column through the view is an error, not a leak
  begin
    perform provider_key from tenant_products;
    raise exception 'provider_key must not be selectable through the view';
  exception when undefined_column then null; end;

  -- and the base table itself stays closed
  assert (select count(*) from provider_connections) = 0, 'base table must stay invisible to clients';

  -- The view is auto-updatable in Postgres (simple single-table view), so only the revoked privileges
  -- stop a client writing through it to provider_connections. Check every kind of write.
  begin
    update tenant_products set last_sync_status = 'succeeded';
    raise exception 'client update through the view should be denied';
  exception when insufficient_privilege then null; end;
  begin
    delete from tenant_products;
    raise exception 'client delete through the view should be denied';
  exception when insufficient_privilege then null; end;
  begin
    insert into tenant_products(tenant_id, product) values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eu_vat');
    raise exception 'client insert through the view should be denied';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ------------------------------------------------------------ client W sees only W
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'uW')::text, false);
do $$ begin
  assert (select count(*) from tenant_products) = 1, 'client W should see exactly its 1 connection';
  assert (select tenant_id from tenant_products) = 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'client W sees only its own tenant';
end $$;
reset role;

-- ------------------------------------------------------------ spoofed staff flag, then real staff
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'uW', 'user_metadata', json_build_object('taxcart_staff', true))::text, false);
do $$ begin
  assert (select count(*) from tenant_products) = 1, 'user_metadata must not widen the view';
end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'uS', 'app_metadata', json_build_object('taxcart_staff', true))::text, false);
do $$ begin
  assert (select count(*) from tenant_products where tenant_id in ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','ffffffff-ffff-ffff-ffff-ffffffffffff')) = 4,
    'staff should see every tenant''s products';
end $$;
reset role;

-- ------------------------------------------------------------ anonymous
set role anon;
do $$ begin
  begin
    perform count(*) from tenant_products;
    raise exception 'anonymous must not read tenant_products';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

\echo 'ALL VIEW CHECKS PASSED'
