-- Taxcart platform: client logos, the view-only "accountant" role, and the staff user list.

-- 1. A third kind of person on a client: an outside accountant who can look but never manage.
--    (All client-side access is read-only already; this records WHO is an accountant so later features,
--    like emails and user management, can treat them differently.)
alter type member_role add value if not exists 'accountant';

-- 2. One small logo per client, shown inside the portal after sign-in.
--    Stored as base64 text (PNG, JPEG or WebP only: never SVG, which can carry scripts) and capped in size.
--    Clients can read their own client's logo; only the backend writes.
create table tenant_logos (
  tenant_id     uuid primary key references tenants(id) on delete cascade,
  content_type  text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  data_b64      text not null check (length(data_b64) between 1 and 300000),
  updated_at    timestamptz not null default now()
);
alter table tenant_logos enable row level security;
create policy tenant_logos_select on tenant_logos
  for select to authenticated
  using (is_tenant_member(tenant_id) or is_staff());
revoke insert, update, delete on tenant_logos from authenticated, anon;
revoke all on tenant_logos from anon;

-- 3. Staff need to see WHO has access to a client (emails live in the sign-in system, not our tables).
--    Backend-only: clients cannot call it.
create or replace function tenant_member_list(p_tenant uuid)
returns table (user_id uuid, email text, role member_role)
language sql stable security definer
set search_path = public, auth
as $$
  select m.user_id, u.email::text, m.role
  from tenant_members m join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant
  order by u.email
$$;
revoke all on function tenant_member_list(uuid) from public, anon, authenticated;
grant execute on function tenant_member_list(uuid) to service_role;
