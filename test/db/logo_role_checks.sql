-- Checks for migration 0005: logos are readable only by their own client (and staff), never writable by clients,
-- limited to safe image types and a size cap; the accountant role works; the staff user list is backend-only.

\set uL '99999999-9999-9999-9999-999999999991'
\set uM '99999999-9999-9999-9999-999999999992'
\set tL '99999999-9999-9999-9999-9999999999a1'
\set tM '99999999-9999-9999-9999-9999999999a2'
insert into auth.users(id, email) values (:'uL','l@x.test'), (:'uM','m@x.test');
insert into tenants(id, name) values (:'tL','Logo L'), (:'tM','Logo M');
insert into tenant_members(tenant_id, user_id, role) values (:'tL', :'uL', 'accountant'), (:'tM', :'uM', 'owner');
insert into tenant_logos(tenant_id, content_type, data_b64) values (:'tL', 'image/png', 'iVBORw0KGgo='), (:'tM', 'image/webp', 'UklGRg==');

do $$ begin
  begin insert into tenant_logos(tenant_id, content_type, data_b64) values ('99999999-9999-9999-9999-9999999999a1', 'image/svg+xml', 'PHN2Zz4='); raise exception 'svg must be refused';
  exception when check_violation or unique_violation then null; end;
  begin update tenant_logos set content_type = 'image/svg+xml' where tenant_id = '99999999-9999-9999-9999-9999999999a1'; raise exception 'svg must be refused on update too';
  exception when check_violation then null; end;
  begin update tenant_logos set data_b64 = repeat('A', 300001) where tenant_id = '99999999-9999-9999-9999-9999999999a1'; raise exception 'oversize logo must be refused';
  exception when check_violation then null; end;
end $$;

set role authenticated;
set request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999991","app_metadata":{}}';
do $$ begin
  assert (select count(*) from tenant_logos) = 1, 'an accountant sees only their own client''s logo';
  assert (select tenant_id from tenant_logos) = '99999999-9999-9999-9999-9999999999a1', 'and it is their own';
  begin insert into tenant_logos(tenant_id, content_type, data_b64) values ('99999999-9999-9999-9999-9999999999a2', 'image/png', 'AA=='); raise exception 'clients must not write logos';
  exception when insufficient_privilege then null; end;
  begin perform tenant_member_list('99999999-9999-9999-9999-9999999999a1'); raise exception 'clients must not list members';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000000","app_metadata":{"taxcart_staff":true}}';
do $$ begin assert (select count(*) from tenant_logos where tenant_id in ('99999999-9999-9999-9999-9999999999a1','99999999-9999-9999-9999-9999999999a2')) = 2, 'staff see all logos'; end $$;
reset role;

set role service_role;
do $$ begin
  assert (select count(*) from tenant_member_list('99999999-9999-9999-9999-9999999999a1')) = 1, 'backend can list members';
  assert (select role from tenant_member_list('99999999-9999-9999-9999-9999999999a1')) = 'accountant', 'and sees the accountant role';
end $$;
reset role;

\echo 'LOGO AND ROLE CHECKS PASSED'
