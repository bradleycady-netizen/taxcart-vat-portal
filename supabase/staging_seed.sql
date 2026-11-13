-- STAGING ONLY. Creates one fictional company with sample filings and registrations so you can see the
-- portal working before any real provider is connected. Never run this on production.
--
-- 1. Create your login first (Authentication > Users > Add user, tick "Auto confirm user").
-- 2. Put that email address below, then run the whole script.
-- It is safe to run twice: it reuses the company if it already exists and does not duplicate rows.

do $$
declare
  v_email   text := 'CHANGE-ME@example.com';   -- <<< your login email
  v_user    uuid;
  v_tenant  uuid;
  v_conn    uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(v_email);
  if v_user is null then
    raise exception 'No user with email % - create the user under Authentication > Users first', v_email;
  end if;

  select id into v_tenant from tenants where name = 'Harbour Test Co (sample data)';
  if v_tenant is null then
    insert into tenants (name) values ('Harbour Test Co (sample data)') returning id into v_tenant;
  end if;

  insert into tenant_members (tenant_id, user_id, role) values (v_tenant, v_user, 'owner')
  on conflict do nothing;

  select id into v_conn from provider_connections where tenant_id = v_tenant and product = 'us_sales_tax' and status = 'active';
  if v_conn is null then
    insert into provider_connections (tenant_id, product, provider_key, credential_ref, last_synced_at, last_sync_status)
    values (v_tenant, 'us_sales_tax', 'zamp', 'ZAMP_PARTNER_KEY', now(), 'succeeded')
    returning id into v_conn;
  end if;

  insert into registrations (connection_id, tenant_id, jurisdiction, tax_id, started_at, ended_at, frequency)
  values
    (v_conn, v_tenant, 'TX', 'SAMPLE-TX-001', date '2025-01-15', null, 'quarterly'),
    (v_conn, v_tenant, 'CA', 'SAMPLE-CA-002', date '2025-03-01', null, 'monthly'),
    (v_conn, v_tenant, 'WA', 'SAMPLE-WA-003', date '2024-06-01', date '2025-12-31', 'annual')
  on conflict (connection_id, jurisdiction, started_at) do nothing;

  insert into filings (connection_id, tenant_id, external_id, jurisdiction, period_code, period_name, frequency,
                       due_on, is_completed, estimated_tax_due, return_confirmation, amount_paid, documents)
  values
    (v_conn, v_tenant, 'TX:2026-Q2', 'TX', '2026-Q2', 'Q2 2026', 'quarterly', date '2026-07-20', true,  1840.25, 'SAMPLE-RC-1001', 1840.25, '[{"kind":"return"}]'),
    (v_conn, v_tenant, 'TX:2026-Q3', 'TX', '2026-Q3', 'Q3 2026', 'quarterly', date '2026-10-20', true,  2210.00, 'SAMPLE-RC-1002', 2210.00, '[{"kind":"return"},{"kind":"payment"}]'),
    (v_conn, v_tenant, 'CA:2026-09',  'CA', '2026-09',  'Sep 2026', 'monthly',  date '2026-10-31', false, 905.40,  null, null, '[]'),
    (v_conn, v_tenant, 'CA:2026-08',  'CA', '2026-08',  'Aug 2026', 'monthly',  date '2026-09-30', true,  812.10,  'SAMPLE-RC-1003', 812.10, '[{"kind":"return"}]'),
    (v_conn, v_tenant, 'TX:2026-Q4',  'TX', '2026-Q4',  'Q4 2026', 'quarterly', date '2027-01-20', false, null,    null, null, '[]')
  on conflict (connection_id, external_id) do nothing;
end $$;
