-- Schema + row-level-security checks. Run after auth_stub.sql and 0001_init.sql.
-- Any failed assertion aborts the script (psql -v ON_ERROR_STOP=1).

\set uA     '11111111-1111-1111-1111-111111111111'
\set uB     '22222222-2222-2222-2222-222222222222'
\set uStaff '33333333-3333-3333-3333-333333333333'
\set tA     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set tB     'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

-- ------------------------------------------------------------ fixtures (as superuser)
insert into auth.users(id, email) values (:'uA','a@x.test'), (:'uB','b@x.test'), (:'uStaff','staff@x.test');
insert into tenants(id, name) values (:'tA','Tenant A'), (:'tB','Tenant B');
insert into tenant_members(tenant_id, user_id) values (:'tA', :'uA'), (:'tB', :'uB');

insert into provider_connections(id, tenant_id, product, provider_key, credential_ref) values
  ('c0000000-0000-0000-0000-00000000000a', :'tA', 'us_sales_tax', 'zamp', 'ZAMP_PARTNER_KEY'),
  ('c0000000-0000-0000-0000-00000000000b', :'tB', 'us_sales_tax', 'zamp', 'ZAMP_PARTNER_KEY');

insert into registrations(connection_id, tenant_id, jurisdiction, started_at) values
  ('c0000000-0000-0000-0000-00000000000a', :'tA', 'KS', '2024-01-01'),
  ('c0000000-0000-0000-0000-00000000000b', :'tB', 'TX', '2024-01-01');

insert into filings(connection_id, tenant_id, external_id, jurisdiction, period_code, period_name, due_on) values
  ('c0000000-0000-0000-0000-00000000000a', :'tA', 'KS:2025-JAN', 'KS', '2025-JAN', 'January 2025', '2025-02-25'),
  ('c0000000-0000-0000-0000-00000000000b', :'tB', 'TX:2025-JAN', 'TX', '2025-JAN', 'January 2025', '2025-02-20');

insert into sync_runs(connection_id) values ('c0000000-0000-0000-0000-00000000000a');
insert into audit_log(tenant_id, action) values (:'tA', 'document.download');

-- ------------------------------------------------------------ client A
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'uA')::text, false);

do $$ begin
  assert (select count(*) from filings) = 1, 'client A should see exactly 1 filing';
  assert (select jurisdiction from filings) = 'KS', 'client A should see only its own filing';
  assert (select count(*) from registrations) = 1, 'client A should see exactly 1 registration';
  assert (select count(*) from tenants) = 1, 'client A should see only its own tenant';
  assert (select count(*) from tenant_members) = 1, 'client A should see only its own membership';
  -- White-label: provider identity and sync internals are invisible to clients.
  assert (select count(*) from provider_connections) = 0, 'client must not see provider_connections';
  assert (select count(*) from sync_runs) = 0, 'client must not see sync_runs';
  assert (select count(*) from audit_log) = 0, 'client must not see audit_log';
end $$;

-- Clients cannot write anything.
do $$ begin
  begin
    insert into filings(connection_id, tenant_id, external_id, jurisdiction, period_code, period_name, due_on)
    values ('c0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'X', 'KS', 'X', 'X', '2025-01-01');
    raise exception 'client insert into filings should have been denied';
  exception when insufficient_privilege then null; end;

  begin
    update filings set amount_paid = 0;
    raise exception 'client update of filings should have been denied';
  exception when insufficient_privilege then null; end;

  begin
    delete from filings;
    raise exception 'client delete from filings should have been denied';
  exception when insufficient_privilege then null; end;

  -- Privilege escalation: a client must not be able to add itself to another tenant.
  begin
    insert into tenant_members(tenant_id, user_id)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111');
    raise exception 'client self-insert into tenant_members should have been denied';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ------------------------------------------------------------ client B sees only B
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'uB')::text, false);
do $$ begin
  assert (select count(*) from filings) = 1 and (select jurisdiction from filings) = 'TX', 'client B should see only TX';
end $$;
reset role;

-- ------------------------------------------------------------ spoofed staff flag in user_metadata
-- user_metadata is user-editable in Supabase; only app_metadata may grant staff.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'uA', 'user_metadata', json_build_object('taxcart_staff', true))::text, false);
do $$ begin
  assert (select count(*) from filings) = 1, 'user_metadata must not grant staff access';
  assert (select count(*) from provider_connections) = 0, 'user_metadata must not reveal provider_connections';
end $$;
reset role;

-- ------------------------------------------------------------ staff (app_metadata flag)
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'uStaff', 'app_metadata', json_build_object('taxcart_staff', true))::text, false);
do $$ begin
  assert (select count(*) from filings) = 2, 'staff should see all filings';
  assert (select count(*) from provider_connections) = 2, 'staff should see provider_connections';
  assert (select count(*) from sync_runs) = 1, 'staff should see sync_runs';
  assert (select count(*) from audit_log) = 1, 'staff should see audit_log';
end $$;
reset role;

-- ------------------------------------------------------------ anonymous
set role anon;
select set_config('request.jwt.claims', '', false);
do $$ begin
  assert (select count(*) from filings) = 0, 'anonymous must see no filings';
  assert (select count(*) from registrations) = 0, 'anonymous must see no registrations';
end $$;
do $$ begin
  begin
    perform count(*) from provider_connections;
    raise exception 'anonymous must not be able to read provider_connections';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ------------------------------------------------------------ provider switching & integrity (superuser)
do $$ begin
  -- A second ACTIVE connection for the same tenant + product is rejected...
  begin
    insert into provider_connections(tenant_id, product, provider_key, credential_ref)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'us_sales_tax', 'other-vendor', 'OTHER_KEY');
    raise exception 'two active connections for one tenant+product should be rejected';
  exception when unique_violation then null; end;

  -- ...a different product on a different provider is fine (providers run concurrently)...
  insert into provider_connections(tenant_id, product, provider_key, credential_ref)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'eu_vat', 'vat-vendor', 'VAT_KEY');

  -- ...and after pausing the old one, switching provider for the same product works.
  update provider_connections set status = 'paused' where id = 'c0000000-0000-0000-0000-00000000000a';
  insert into provider_connections(tenant_id, product, provider_key, credential_ref)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'us_sales_tax', 'other-vendor', 'OTHER_KEY');

  assert (select count(*) from provider_connections where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and status = 'active') = 2,
    'tenant A should now have 2 active connections (one per product)';
end $$;

do $$ begin
  -- Filing natural key is unique per connection (upsert target).
  begin
    insert into filings(connection_id, tenant_id, external_id, jurisdiction, period_code, period_name, due_on)
    values ('c0000000-0000-0000-0000-00000000000b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'TX:2025-JAN', 'TX', '2025-JAN', 'dup', '2025-02-20');
    raise exception 'duplicate filing natural key should be rejected';
  exception when unique_violation then null; end;

  -- A connection that owns synced history cannot be deleted out from under it.
  begin
    delete from provider_connections where id = 'c0000000-0000-0000-0000-00000000000b';
    raise exception 'deleting a connection with filings should be restricted';
  exception when foreign_key_violation then null; end;
end $$;

\echo 'ALL DATABASE CHECKS PASSED'
