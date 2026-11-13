# Taxcart platform (foundation)

Provider-neutral core for the white-label portal: database schema, provider adapters (Zamp now, your VAT vendor next), a sync engine that keeps a cached copy of each client's data, email-code login, and the data and document endpoints the portal pages call.

## How it fits together

```
Portal pages --> /api endpoints --> your database (Supabase) <-- sync runner <-- provider adapters --> Zamp / VAT vendor
 (browser)       (login, data,       (clients read only        (scheduled,        (one per vendor)
                  documents)          this)                     server-side)
```

- **Clients never talk to a provider.** They read synced data from your database, so the portal looks the same whichever vendor serves them, and a vendor outage doesn't take it down.
- **Provider identity is hidden from clients.** `provider_connections` and `sync_runs` are staff-only. Clients get a narrow view (`tenant_products`) showing only which products they have and when data was last refreshed.
- **One connection per client per product.** US sales tax can run on Zamp while VAT runs on another vendor, at the same time. Switching vendors means pausing the old connection and adding a new one; the old vendor's filing history stays visible.
- **Secrets are never in the database.** A connection stores the *name* of an environment variable (`credential_ref`), not the key.
- **History is permanent.** The sync only inserts or updates. It never deletes filings.
- **Documents are streamed by your server.** Clients are never redirected to, or told, the vendor's link. Every download is recorded in `audit_log` *before* any data is sent.

## Folder map

| Path | What it is |
|---|---|
| `supabase/migrations/` | `0001` tables and security rules, `0002` sync locking and login throttle, `0003` client-safe products view |
| `src/core/` | Provider-neutral data model, adapter contract, shared error type |
| `src/providers/zamp/` | Zamp adapter (HTTP client, response validation, mapping) |
| `src/providers/mock/` | Fake second provider; also the template for the VAT vendor |
| `src/providers/registry.ts` | Picks the right adapter for each connection |
| `src/sync/` | Sync engine, scheduled runner, Supabase store and connection source |
| `src/http/` | Config, login, session cookies, data and document handlers, cron handler |
| `entry/` | Thin serverless entry points (TypeScript source) that call the handlers |
| `api/` | **Built** JavaScript functions Vercel deploys, generated from `entry/` and `src/`. Do not edit by hand. After changing anything in `src/` or `entry/`, run `npm run build:api` (`npm test` fails if `api/` is stale) |
| `public/` | The portal pages: `index.html`, `styles.css`, `js/api.js` (endpoint client), `js/format.js` (display helpers), `js/app.js` (screens) |
| `vercel.json` | Scheduled sync (daily at 06:00 UTC on the free plan), function time limit, security headers and Content-Security-Policy |
| `scripts/build-api.mjs` | Bundles `entry/` into `api/` |
| `scripts/zamp-smoke.ts` | Read-only live check of the Zamp adapter against a real key |
| `test/` | 133 unit tests, database security and schema tests, and `test/ui/smoke.mjs` (real-browser check) |

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/request-code` `{email}` | Emails a sign-in code. Same reply whether or not the address is registered |
| `POST /api/auth/verify-code` `{email, code}` | Checks the code and sets the session cookies |
| `POST /api/auth/logout` | Ends the session and clears cookies |
| `GET /api/session` | Who is signed in, their clients, and which products each has (drives the US Sales Tax / VAT branch) |
| `GET /api/filings?tenant=&product=&limit=&offset=` | A client's filings, newest due first, with download links and a `sync` freshness note |
| `GET /api/registrations?tenant=&product=` | A client's registrations |
| `GET /api/documents?filing=&kind=` | Streams one filing document |
| `GET /api/filings?format=csv&tenant=&product=` | A client's filings as a CSV spreadsheet file (formula-safe, audited, rate limited) |
| `GET /api/logo?tenant=` | The client's logo image (PNG, JPEG or WebP), for people who belong to that client |
| `/api/staff?op=...` | **Staff only**, one function for all staff actions (the free Vercel plan allows 12 functions). `GET op=clients` lists clients and their refresh health (never tokens); `POST op=create-client` `{name, product, provider, token, providerCompanyId?, email?}` checks the token, saves the client with the token encrypted, optionally creates the first user, runs a first refresh; `POST op=sync` `{connectionId}` refreshes one client now; `GET op=users&tenant=` / `POST op=add-user` `{tenantId, email, role}` / `POST op=remove-user` `{tenantId, userId}` manage access (owner / user / accountant, view only); `POST op=logo` `{tenantId, data}` or `{tenantId, remove: true}` sets or removes a logo (PNG/JPEG/WebP, max 150 KB, checked by contents; SVG refused). Anyone who is not staff gets a plain 404 |
| `/api/vat?op=...` | The manual VAT service: client uploads, checks, replies, downloads; staff queue, statuses, questions, return PDFs, filings. See `docs/VAT.md` |
| `GET /api/cron/sync` | Scheduled sync. Needs `Authorization: Bearer <CRON_SECRET>`. Optional `?connection=<id>` syncs one connection by hand |

**For the portal pages:** call these with `fetch(url, { credentials: 'same-origin' })`. On a `401`, send the person to the login screen. A `sync.status` of `stale` means show "data may be out of date, as of <asOf>"; `pending` means the first sync hasn't finished yet.

## Setup, step by step

1. **Install.** Node 22.18 or newer. In this folder run `npm install`, then `npm test` and `npm run typecheck`.
2. **Create a Supabase project** (staging first). In the SQL editor run every file in `supabase/migrations/` in order (0001 to 0005).
3. **Configure email sign-in codes** in the Supabase dashboard. This part is essential:
   - *Authentication > Providers > Email*: turn **off** "Allow new users to sign up" (invite-only).
   - *Authentication > Emails > Magic Link template*: the email body must contain `{{ .Token }}` (for example "Your Taxcart sign-in code is {{ .Token }}"). Remove the `{{ .ConfirmationURL }}` link so the code is the only way in.
   - *Authentication > SMTP*: set up your own email provider (Resend, Postmark, SES and so on). Supabase's built-in email sender is limited to a handful of messages an hour and is not meant for production, so without this, real clients won't receive codes.
   - Set the code length to 6 and its expiry to 10 minutes (600 seconds) or less.
4. **Create your own staff login.** Add yourself as a user, then set `app_metadata` to `{"taxcart_staff": true}` using the dashboard or the service role. Never use `user_metadata`; users can edit that themselves.
5. **Environment variables.** Copy `.env.example` to `.env.local` and fill it in (on Vercel: Project Settings > Environment Variables). Generate each secret with `openssl rand -hex 32`. The service-role key must only ever live on the server. `CREDENTIAL_ENCRYPTION_KEY` (32 random bytes, `openssl rand -base64 32`) encrypts each client's provider token; **keep a copy in your password manager, because tokens saved with it cannot be recovered without it.**
6. **Add a client.** Sign in as staff and use **Clients (staff)** in the left menu: client name, the client's own provider token, and optionally the first user's email. The token is checked before anything is saved, then stored encrypted, and a first refresh runs straight away. (The SQL below still works for a shared key held in an environment variable.)
   ```sql
   insert into tenants (name) values ('Client Name') returning id;
   -- create the person under Authentication > Users (tick "Auto confirm"), then:
   insert into tenant_members (tenant_id, user_id) values ('<tenant id>', '<user id>');
   insert into provider_connections (tenant_id, product, provider_key, provider_company_id, credential_ref)
   values ('<tenant id>', 'us_sales_tax', 'zamp', '<zamp company id, once you have partner access>', 'ZAMP_PARTNER_KEY');
   ```
6b. **Staging only: sample data.** `supabase/staging_seed.sql` creates a fictional company with sample filings and registrations for your login, so the portal can be seen working before any provider is connected. Never run it on production.
7. **First sync:** `curl -X POST -H "Authorization: Bearer $CRON_SECRET" "https://<your-site>/api/cron/sync"`. After that the schedule keeps it fresh.
8. **When you have the Zamp trial key,** run `ZAMP_API_KEY=... node scripts/zamp-smoke.ts`. It is read-only and prints PASS/FAIL plus field names and types, never data values. Paste the output back if anything fails.

## Adding the VAT vendor

1. Copy `src/providers/mock/adapter.ts` to `src/providers/<vendor>/adapter.ts` and replace the fake data with real calls.
2. Set `capabilities` honestly. Features the vendor lacks stay `false` and the sync engine skips them.
3. Register it in `src/providers/registry.ts`.
4. Add a `provider_connections` row with `product = 'eu_vat'`.

Nothing else changes.

## What is and isn't verified

| Area | Status |
|---|---|
| Zamp adapter, mapping, retries, pagination | Tested against the payloads in Zamp's public docs. **No live key yet** |
| Sync engine and scheduled runner (outages, isolation, no deletes, time budget, overlapping runs) | Tested; each rule also confirmed to fail when deliberately broken |
| Database schema, security rules, products view, sync locking, login throttle | Tested on a real Postgres 16: cross-client isolation, hidden vendor identity, blocked writes, spoofed staff flag, locking, throttle. Each rule also confirmed to fail when deliberately broken |
| Login, session cookies, data and document endpoints | 118 tests with fake services; 19 deliberate security breaks all caught |
| Portal pages (`public/`) | 15 tests on the endpoint client, formatting, escaping and CSP-cleanliness (8 deliberate breaks caught), plus a real Chromium run of the pages against a fake API with the production CSP: sign-in, wrong code, product switch, filings, registrations, downloads link, sign-out, expired session, phone layout. **Not yet run against the real API** |
| Every table, column, function and argument name the code uses | Cross-checked against the real schema |
| **Real Supabase** (`SupabaseStore`, `SupabaseAuthApi`, `SupabaseThrottle` and friends, `buildDeps.ts`) | **Not run against a live project.** Written to Supabase's documented behaviour; test on staging first |
| **Vercel deployment** (`api/` built functions, `vercel.json`) | Deployed to a staging project. The first attempt failed because Vercel could not resolve our TypeScript imports, so the functions are now pre-built into plain JavaScript (`npm run build:api`). Tested locally; confirm on staging |
| `npm run typecheck` | **Not yet run.** The sandbox this was built in could not install packages |
| Live Zamp responses | Read-only check run against the Zamp sandbox on 6 Nov: authenticate, registrations and filings list all PASS. Filings are empty there, so filing details and document links are **not yet seen** |
| Export, logos, users and the accountant role | 13 further tests (CSV contents and formula safety, who can see which logo, upload rules, add/remove user), database checks on Postgres 16, and a Chromium run of the screens against a fake API. **Not yet run against live Supabase** |
| Per-client tokens and staff add-client screen | 24 new tests (encryption round trip, wrong key, tampering, who may call, rollback, token never echoed/logged/audited), database checks on Postgres 16, and a Chromium run of the screen against a fake API. **Not yet run against live Supabase** |

## Design trade-offs worth knowing

- **Lockout can be abused.** After 5 wrong codes in 15 minutes an address is locked out. That stops guessing, but someone who knows a client's email could deliberately lock them out for up to 15 minutes. Limits are in `src/http/limits.ts`.
- **A tiny timing difference remains.** Registered addresses take slightly longer to answer (an email is actually sent). The replies are identical; the timing is not hidden.
- **Silent email failures are possible.** Because "no such account" and "rate limited" must look the same to the person, a project-wide email limit would stop codes without any error on screen. It is logged as `auth.send_code.rejected` so you can watch for it.
- **One extra network call per request** checks the session with Supabase. It is what lets a revoked session stop working immediately.
- **Staff can read any client** through the same endpoints (row-level security allows it). Staff logins and downloads are recorded; staff *viewing lists* is not.
- **Scheduler frequency.** `vercel.json` runs the sync once a day (`0 6 * * *`), the most the free Vercel plan allows. On a paid plan you can use `0 */6 * * *`; the test in `test/build.test.ts` expects the daily value, so update it too.
- **Crashed runs** are cleaned up automatically after 15 minutes. A permanently failing connection is retried every pass and sorts first, so keep an eye on `last_sync_error`.
- **Duplicate history.** If an old and a new provider both hold the same filing, the portal would list it twice. Not handled yet.

## Known gaps and open questions for Zamp

- **Nexus tracker:** no documented endpoint, so `nexusTracking` is `false` for Zamp.
- **Approved on/by:** not a documented filing field.
- **Frequency codes** `MDFA`, `MP`, `NYA`, `NYQ`, `NYQP`, `QP` are undefined in the docs. They are stored as `other` with the raw code kept.
- **Partner access:** the `companyId` parameter is described as partner-only. It is wired through, but untested until you have a partner key.
- **Document links** expire after 1 hour, so they are never stored; a fresh one is fetched on every download.

## The portal pages

- One page (`public/index.html`), hash-free, no build step, no libraries. Served as static files by Vercel.
- Sign-in is the real email-code flow. If the session expires mid-use the person is returned to sign-in with a message.
- A company with both products gets a switcher; the product, company name and email come from `/api/session`. A login with several companies gets a company picker.
- **Overview, Filings, Registrations** read from the endpoints, with loading, empty, error (with retry), "as of" / out-of-date / still-setting-up notes, paging and download links.
- **Nexus tracking** shows a plain "your tax team is monitoring this" card, with no numbers, because no data source exists yet. When one does, replace `nexusPlaceholder()` in `public/js/format.js`.
- **Amounts:** US sales tax shows USD. VAT shows plain amounts because the currency isn't in the data model yet; add a `currency` once the VAT vendor's data is known.
- **A staff login with no company attached** sees a "no company linked" message. A staff company picker is not built.
- The Google Fonts link is the only external request the pages make (the CSP allows only that).
- **Local check without Vercel:** `PLAYWRIGHT_DIR=<folder containing node_modules/playwright> node test/ui/smoke.mjs`.

## The VAT service

Built: see `docs/VAT.md` (manual model: uploads, six statuses, questions, return PDFs; pages at `/vat/`). The older note below is kept for history.

## The VAT prototype (superseded)

`taxcart_portal_prototype_v3.html` is a manual workflow: clients upload sales files with required labels, ops staff move submissions through statuses, raise queries, and attach finished returns. None of that exists in the backend, and its shape depends on how the VAT vendor takes data (API, file drop, or people). Rather than build tables and storage that may be thrown away, the unified portal shows VAT **filings and registrations** through the same endpoints, and the upload / queries / ops screens wait on that decision. When the vendor is chosen, these are the pieces to add: a submissions table, file storage with virus scanning, a queries thread, and a staff-only ops view.

## Not built yet

- A staff screen for adding clients and switching providers (today it is SQL, as in step 6), and a staff company picker
- VAT emails, virus scanning, retention rules (see `docs/VAT.md`)
- Nexus tracker data (waiting on Zamp)

## Look and feel

The portal uses the original prototype design (dark login panel, dashboard hero card, sidebar with icons). Only real data is shown. The login headline ("Sales tax, handled.") lives in `renderLogin()` in `public/js/app.js` and can be changed there. The nexus card is a plain placeholder until nexus data is available from the provider.
