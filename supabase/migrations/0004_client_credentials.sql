-- Taxcart platform: per-client provider tokens, stored encrypted, plus what the staff add-client screen needs.
--
-- Until now a connection pointed at an environment variable (credential_ref = its NAME). That still works, and is
-- still the right choice for one shared key. But each client now has their own provider token, and adding an
-- environment variable and redeploying for every new client does not scale. So a connection may instead hold its
-- token ENCRYPTED in credential_enc (AES-256-GCM; the key lives only in the CREDENTIAL_ENCRYPTION_KEY environment
-- variable, never in the database). A copy of the database alone therefore still cannot reveal any token.
--
-- Rule 5 of 0001 becomes: "No PLAINTEXT secret ever lives in the database."

alter table provider_connections alter column credential_ref drop not null;
alter table provider_connections add column credential_enc text;

alter table provider_connections
  add constraint provider_connections_has_credential
  check (credential_ref is not null or credential_enc is not null);

-- Clients can never read provider_connections (staff-only policy, unchanged), so credential_enc is invisible to them.
-- The tenant_products view lists explicit columns and deliberately omits it.

-- Finds an existing sign-in user by email (the admin API has no lookup-by-email). Backend-only.
create or replace function auth_user_id_by_email(p_email text) returns uuid
language sql stable security definer
set search_path = public, auth
as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1
$$;
revoke all on function auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function auth_user_id_by_email(text) to service_role;
