-- Checks for migration 0004: a connection may hold an env-var NAME or an ENCRYPTED token (at least one),
-- clients can never read either, and the email lookup is backend-only.

\set uC '77777777-7777-7777-7777-777777777777'
\set tC '88888888-8888-8888-8888-888888888888'
insert into auth.users(id, email) values (:'uC','Carol@x.test');
insert into tenants(id, name) values (:'tC','Credential Tenant');
insert into tenant_members(tenant_id, user_id) values (:'tC', :'uC');

do $$ begin
  -- env-var style still works
  insert into provider_connections(tenant_id, product, provider_key, credential_ref)
  values ('88888888-8888-8888-8888-888888888888', 'us_sales_tax', 'zamp', 'ZAMP_PARTNER_KEY');
  update provider_connections set status = 'paused' where tenant_id = '88888888-8888-8888-8888-888888888888';
  -- stored-token style works with no env var name
  insert into provider_connections(tenant_id, product, provider_key, credential_enc)
  values ('88888888-8888-8888-8888-888888888888', 'us_sales_tax', 'zamp', 'v1.aaa.bbb.ccc');
  -- neither is not allowed
  begin
    insert into provider_connections(tenant_id, product, provider_key)
    values ('88888888-8888-8888-8888-888888888888', 'eu_vat', 'vat-vendor');
    raise exception 'a connection with no credential at all should be rejected';
  exception when check_violation then null; end;
end $$;

-- A client cannot read connections (and so cannot read credential_enc), nor see it through the view
set role authenticated;
set request.jwt.claims = '{"sub":"77777777-7777-7777-7777-777777777777","app_metadata":{}}';
do $$ begin
  assert (select count(*) from provider_connections) = 0, 'clients must not read provider_connections';
  assert (select count(*) from tenant_products where tenant_id = '88888888-8888-8888-8888-888888888888') = 2, 'client sees their own subscriptions';
  begin
    perform auth_user_id_by_email('carol@x.test');
    raise exception 'clients must not be able to look up users by email';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- The backend can, case-insensitively
set role service_role;
do $$ begin
  assert auth_user_id_by_email('carol@X.TEST') = '77777777-7777-7777-7777-777777777777', 'service role should find the user';
  assert auth_user_id_by_email('nobody@x.test') is null, 'unknown email gives null';
end $$;
reset role;

\echo 'CREDENTIAL CHECKS PASSED'
