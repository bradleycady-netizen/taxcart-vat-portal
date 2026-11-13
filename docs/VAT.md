# The VAT service (manual model)

Clients upload sales files per scheme and period. Taxcart staff move each return through six statuses, ask questions, and attach the finished return PDF. Nothing here talks to an outside provider.

**Address:** `/vat/` (static pages in `public/vat/`). The US sales tax portal stays at `/`. Both use the same sign-in, the same Supabase project and the same people (staff are marked `app_metadata.taxcart_staff = true`).

## What a person sees

- **Client:** My returns (cards with a six-step progress bar, waiting-for-file cards for periods that have ended), New submission (choose filing and period, add a file, it is checked, then submit), Questions (what Taxcart asked), Documents (their uploads and finished returns), return detail (history and messages).
- **Staff:** Submissions (queue with counts and filters), return detail (download the file, see what was read from it, change status and due date, ask a question, attach the return PDF), Clients (add a client, set up filings, give people access), Countries & schemes.

## Statuses

Submitted → Received → In review → Return prepared → Filed → Complete. Staff can set any status (to correct a slip). A return must have its PDF attached before it can be Filed or Complete. Clients only see the PDF from "Return prepared" onwards. Lists are in `src/vat/config.ts`.

## Filings (what a client is registered for)

A client has one or more rows in `vat_registrations`: scheme (`uk_vat`, `ioss`, `oss`, `local_vat`), country, frequency (monthly / quarterly / annual). The client can only upload for these. Rules (`validRegistration` in `src/vat/config.ts`): UK VAT is GB only; IOSS is monthly and OSS quarterly, both in an EU member state; local VAT can be any country and frequency. IOSS is modelled as ONE filing in the member state of identification, not one per destination country.

## Due dates

`defaultDueDate()` in `src/vat/config.ts` gives an indicative date when a return is created (UK: one month and seven days after the period; IOSS: end of the next month; OSS: end of the month after the quarter; local VAT: end of the next month). These are defaults to be confirmed. Staff can change the date on any return and the change is recorded.

## Upload checks (`src/vat/validate.ts`)

Run when the file is chosen (nothing saved) and again on submit. CSV (comma, semicolon or tab; UTF-8 or UTF-16) and `.xlsx`; old `.xls` is refused. Maximum 4 MB and 50,000 rows (Vercel limits a request to about 4.5 MB). Column headings are matched loosely against the lists in `SYNONYMS` at the top of the file. **When Shopify's exact columns are confirmed, adjust that list.**

- **Errors (stop the submission):** unreadable file, missing date / country / amount column, no rows, blank required cells, unreadable dates, invalid countries, unreadable amounts, more than 5% of rows outside the period.
- **Warnings (client may go ahead):** a few rows outside the period, IOSS/OSS rows shipping outside the EU, repeated orders, mixed currencies, refunds (negative rows), no currency column.
- Shopify's extra line-item rows (only the order name filled in) are skipped, not counted as blanks.
- The summary (orders, totals per currency, sales by country, columns read) is shown to the client and kept for staff.

## Where things are stored

- Tables `vat_registrations`, `vat_returns`, `vat_events` (migration `0006_vat_returns.sql`). Clients can read their own rows through row-level security and cannot write anything; the backend writes after checking who is asking.
- Files are in a **private** Supabase Storage bucket called `vat-files` (created by the migration, or by the first upload if it is missing). Paths look like `<client>/<return>/upload-<hash>.csv`. Nobody reaches the bucket directly; downloads use links that work for one minute, created after an access check and recorded in the audit log.
- Who may change what: owners and members of a client can upload and reply; the view-only `accountant` role can only read; staff can do everything.

## Endpoint: `/api/vat?op=...` (one function, `entry/vat.ts`, code in `src/http/handlers/vat.ts`)

Client: `GET list&tenant=`, `GET detail&id=`, `GET download&id=&kind=upload|return`, `POST check&tenant=&scheme=&country=&period=` (raw file body), `POST submit&...` (raw file body), `POST reply {id, body}`.
Staff (anyone else gets a plain 404): `GET queue`, `GET clients`, `POST staff-status {id, status, dueOn?, note?}`, `POST staff-ask {id, body}`, `POST staff-return&id=` (raw PDF body), `POST staff-register {tenantId, scheme, country, frequency, vatNumber?}`, `POST staff-unregister {id}`, `POST staff-client {name, email?}`. Giving a client's person access reuses `/api/staff?op=add-user`.
Files are sent as the raw request body (`Content-Type: application/octet-stream`, name in the `X-File-Name` header), not as JSON.

## Not built (on purpose, for the test site)

Emails of any kind (including "your return was filed"); virus scanning of uploads; file retention/deletion rules; fees/invoicing; larger-than-4 MB files (would need direct-to-storage uploads, which means loosening the page's `connect-src` policy to allow the storage address); separate VAT domain/branding settings; multi-language.

## Checking changes

`npm test` (213 tests, no network), `npm run build:api` after editing anything in `src/` or `entry/` (and commit `api/`), `node test/ui/vat-smoke.ts` for a real-browser run of both client and staff flows against the real handlers (needs Playwright; set `PLAYWRIGHT_DIR` if it is not found, and `SHOTS=<folder>` for screenshots). Database checks: `test/db/run.sh` against a scratch Postgres only, never a real project.

## View as client (staff)
Clients page → "View as client" shows the client screens for that company. Server side: `preview=1` on list/detail hides staff-only data; `behalf` on submit/reply records the action as the client's and writes an audit entry (`vat.reply_on_behalf`, `onBehalfOfClient`). Clients cannot use it.
