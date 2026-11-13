-- Taxcart platform: what clients may know about their own subscriptions.
--
-- provider_connections is staff-only (it names the vendor, the vendor's company ID and the credential
-- reference), but the portal still has to know, for the signed-in client:
--   * which products they have (US sales tax, VAT) so it can branch to the right workspace,
--   * which connection ids hold their data (to query filings/registrations),
--   * when the data was last refreshed, and whether the last refresh failed (the "as of" note).
--
-- This view exposes exactly that and nothing else. It deliberately omits provider_key,
-- provider_company_id, credential_ref and the error text.
--
-- Views run with their OWNER's privileges (which bypass row-level security on the base table), so the
-- membership filter lives inside the view itself. is_tenant_member()/is_staff() read the CALLER's
-- JWT, so each client still sees only their own tenant's rows.

create view tenant_products as
  select
    pc.id                as connection_id,
    pc.tenant_id         as tenant_id,
    pc.product           as product,
    (pc.status = 'active') as is_active,       -- false = an earlier provider, kept so history stays visible
    pc.last_synced_at    as last_synced_at,
    pc.last_sync_status  as last_sync_status
  from provider_connections pc
  where is_tenant_member(pc.tenant_id) or is_staff();

revoke all on tenant_products from anon, authenticated;
grant select on tenant_products to authenticated;
