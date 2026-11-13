-- Checks for migration 0006: VAT returns are readable only by their own client (and staff), never writable by clients,
-- limited to the six statuses, and one return per client, scheme, country and period.

\set uV '88888888-8888-8888-8888-888888888881'
\set uW '88888888-8888-8888-8888-888888888882'
\set tV '88888888-8888-8888-8888-8888888888a1'
\set tW '88888888-8888-8888-8888-8888888888a2'
insert into auth.users(id, email) values (:'uV','v@x.test'), (:'uW','w@x.test');
insert into tenants(id, name) values (:'tV','Vat V'), (:'tW','Vat W');
insert into tenant_members(tenant_id, user_id, role) values (:'tV', :'uV', 'owner'), (:'tW', :'uW', 'owner');
insert into vat_registrations(tenant_id, scheme, country, frequency) values (:'tV','uk_vat','GB','quarterly'), (:'tW','ioss','PL','monthly');
insert into vat_returns(id, tenant_id, scheme, country, period_code, period_start, period_end) values
  ('88888888-8888-8888-8888-8888888888b1', :'tV', 'uk_vat', 'GB', '2026-Q3', '2026-07-01', '2026-09-30'),
  ('88888888-8888-8888-8888-8888888888b2', :'tW', 'ioss', 'PL', '2026-10', '2026-10-01', '2026-10-31');
insert into vat_events(return_id, tenant_id, actor_side, kind) values ('88888888-8888-8888-8888-8888888888b1', :'tV', 'client', 'submitted'), ('88888888-8888-8888-8888-8888888888b2', :'tW', 'client', 'submitted');

do $$ begin
  begin insert into vat_returns(tenant_id, scheme, country, period_code, period_start, period_end) values ('88888888-8888-8888-8888-8888888888a1', 'uk_vat', 'GB', '2026-Q3', '2026-07-01', '2026-09-30'); raise exception 'duplicate period must be refused';
  exception when unique_violation then null; end;
  begin update vat_returns set status = 'banana' where id = '88888888-8888-8888-8888-8888888888b1'; raise exception 'unknown status must be refused';
  exception when check_violation then null; end;
  begin update vat_returns set period_code = '2026-13x' where id = '88888888-8888-8888-8888-8888888888b1'; raise exception 'bad period code must be refused';
  exception when check_violation then null; end;
  begin insert into vat_registrations(tenant_id, scheme, country, frequency) values ('88888888-8888-8888-8888-8888888888a1', 'other', 'GB', 'monthly'); raise exception 'unknown scheme must be refused';
  exception when check_violation then null; end;
end $$;

set role authenticated;
set request.jwt.claims = '{"sub":"88888888-8888-8888-8888-888888888881","app_metadata":{}}';
do $$ begin
  assert (select count(*) from vat_returns) = 1, 'a client sees only their own returns';
  assert (select count(*) from vat_events) = 1, 'and only their own events';
  assert (select count(*) from vat_registrations) = 1, 'and only their own registrations';
  begin update vat_returns set status = 'complete'; raise exception 'clients must not change returns';
  exception when insufficient_privilege then null; end;
  begin insert into vat_events(return_id, tenant_id, actor_side, kind) values ('88888888-8888-8888-8888-8888888888b1', '88888888-8888-8888-8888-8888888888a1', 'staff', 'status'); raise exception 'clients must not write events';
  exception when insufficient_privilege then null; end;
  begin delete from vat_registrations; raise exception 'clients must not delete registrations';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set role anon;
do $$ begin
  begin perform count(*) from vat_returns; raise exception 'anon must not read returns';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000000","app_metadata":{"taxcart_staff":true}}';
do $$ begin assert (select count(*) from vat_returns where tenant_id in ('88888888-8888-8888-8888-8888888888a1','88888888-8888-8888-8888-8888888888a2')) = 2, 'staff see every client''s returns'; end $$;
reset role;

\echo 'VAT CHECKS PASSED'
