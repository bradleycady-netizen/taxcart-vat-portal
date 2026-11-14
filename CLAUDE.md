# Taxcart platform: notes for Claude

Shared notes between Brad and Priyank are in `NOTES.md`: read it at the start of a session, and when asked to add a note, edit it and commit.

Client portals for Taxcart (a tax compliance firm). Two services share one Supabase project and one Vercel project: US sales tax (`public/index.html`, provider-fed, paused) and the manual VAT service (`public/vat/`, live for testing). Read `README.md` for the whole system and `docs/VAT.md` for the VAT service.

## Rules that must not be broken
- **No secrets in the repo, in chat or in prompts.** Keys live only in Vercel and Supabase settings. Never print, log or commit `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, `CRON_SECRET`, `AUTH_THROTTLE_SECRET`, or any provider token.
- **Client data isolation.** Reads for clients go through `deps.userDb(accessToken)` so row-level security applies. `deps.serviceDb` bypasses it: use it only after the handler has checked who is asking. Staff endpoints answer non-staff with a plain 404.
- **The page's Content-Security-Policy (in `vercel.json`) is strict:** no inline scripts, no inline `style=""` attributes, no inline event handlers, only the site itself plus Google Fonts. Style with classes in the CSS files. `test/vatFrontend.test.ts` enforces this for the VAT pages.
- **Client pages never name any outside vendor.** Taxcart branding only.
- **Vercel free plan allows 12 serverless functions;** we use 11 and a test enforces at most 11. Add operations to an existing function's `?op=` router instead of creating a new `entry/*.ts`.
- After changing anything under `src/` or `entry/`, run `npm run build:api` and keep `api/` in the commit (a test fails if it is stale).
- Database changes are new numbered files in `supabase/migrations/` (never edit one that has been run). Add checks in `test/db/` and test with `test/db/run.sh` on a scratch Postgres.
- Every change needs tests: `npm test` must pass (Node 22.18+, native TypeScript: no parameter properties, enums or decorators).

## Where things are
- `src/vat/config.ts` statuses, schemes, countries, periods, due dates. `src/vat/validate.ts` the upload checks (headings in `SYNONYMS`). `src/vat/xlsx.ts`, `csv.ts` readers (no libraries).
- `src/http/handlers/vat.ts` every VAT operation. `public/vat/js/` the pages (`views.js` markup, `app.js` behaviour, `flags.js`, `format.js`).
- Tests: `test/vat*.test.ts`; real-browser run: `node test/ui/vat-smoke.ts`.

## Style
Plain, short wording in anything a client reads. British spelling. Dates as "30 Nov 2026". Keep error messages friendly and say what to do next.

## People
Brad (ops/product) works with Claude and is not a developer; explain changes in plain language and give Windows Command Prompt commands. Priyank's team operates the VAT service day to day.
