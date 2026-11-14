# Notes between Brad and Priyank

A shared scratch file. Add a note, question or answer, commit it, and the other person sees it in GitHub. Newest entries go at the top of each section. Sign and date each one (for example "Brad, 14 Nov").

**Never put passwords, keys, tokens, sign-in codes or client data in this file.** This repository is not the place for them. Say "it's in Bitwarden" instead.

How to add a note on github.com without any tools: open this file, click the pencil icon (Edit), type under the right heading, then click "Commit changes". Priyank can also ask his Claude to add a note and commit it.

---

## Questions for Priyank (Brad to Priyank)

- [ ] Brad, 14 Nov: Which member state will we register IOSS in for the pilot clients, and are the default due dates in `src/vat/config.ts` (`defaultDueDate`) right for UK VAT, IOSS, OSS and local VAT?
- [ ] Brad, 14 Nov: Should a return really be blocked from Filed/Complete until the return PDF is attached? (Currently yes.)

## Questions for Brad (Priyank to Brad)

- [ ] (none yet)

## Decisions made

- 13 Nov: VAT service is Taxcart-branded only, lives at `/vat/` in the same project as the US sales tax portal. Manual model: clients upload, staff prepare and file.
- 13 Nov: Pilot scope is UK VAT and IOSS. No automatic emails yet.

## Things to change after testing

- [ ] Shopify column headings: tune `SYNONYMS` in `src/vat/validate.ts` once we have a real export.
- [ ] Sending domain for sign-in emails (so the whole team can sign in).

## Bugs and observations from testing

- (add here: what you did, what you expected, what happened)

## Log of changes

- 13 Nov: Brad and Claude built the first VAT test site (see `docs/VAT.md`).

- Update: staff "View as client" button on the VAT Clients page (preview banner, "Exit preview"); staff uploads/replies made while previewing are recorded as the client's and audited. Clients page now labels VAT filings. Code-only redeploy, no database change.

- Update: automatic welcome email built but switched OFF. To turn on after the sending domain is verified: set INVITE_EMAILS_ENABLED=true and RESEND_API_KEY in Vercel, redeploy. Wording lives in src/http/mailer.ts (Priyank/Brad to approve). See docs/VAT.md.

- Plan once Priyank confirms the required columns: (1) keep flexible header matching and add synonyms from real client files; (2) add a downloadable Taxcart template on the upload page; (3) add a "match your columns" step (client picks the right column from a dropdown when auto-detect fails); (4) optionally remember each client's column choices.

- Due dates (Brad + wife confirmed by web check, Nov 2026): UK VAT = one calendar month and 7 days after the period ends (gov.uk); IOSS = monthly, due end of the following month; OSS (Union and Non-Union) = quarterly, due end of the month after the quarter (EU Commission OSS page). Nil returns are required for OSS/IOSS even with no sales. Local VAT: rules differ by country, so staff set the due date per return (the site lets staff edit it).
- Launch schemes: all four (UK VAT, IOSS, OSS, local VAT).

- Update: "No sales this period" (nil return) button added for clients, replacing the old workaround of emailing or sending a blank template. Staff see it as a Submitted return labelled "No sales". Code only, no database change.

- Answers from Brad (14 Nov): staff day-to-day = Priyank's operations team, usually reply same day. Filing emails go to the shared inbox consulting@taxcart.com.au. Data currently kept in Australia (OneDrive); portal files live in the Supabase project region (TO CHECK: Supabase Settings > General > Region). Retention: indefinite for now; deletion on request once the client relationship has ended (no delete button yet; done by hand in Supabase). Contract/privacy wording and data-handling rules: confirm with lawyer. Welcome email wording approved. Due dates confirmed (see above); local VAT due date set per return by staff.

- Update: staff alerts to consulting@taxcart.com.au when a client uploads, sends a nil return or replies (off until email is switched on, same settings as the welcome email). Client-facing notifications (question asked, status changes) not built yet.

- Decision (Brad, 14 Nov): offer BOTH a downloadable Taxcart template and accept whatever clients export. Plan: (1) Priyank confirms the minimum information every upload must contain, per scheme (UK VAT, IOSS, OSS, local VAT); (2) Claude sets the site's required columns to match and builds the template from that list; (3) keep flexible heading matching, add the "match your columns" step as a safety net; (4) test with 2-3 real sample files. Detailed questions (dates, amounts, reversals, currency) are held until the minimum list is known. Sample received: a Shopify "Total sales by EU Countries" report (.numbers) with no date column and full country names; it is rejected today because there is no date column.

- Supabase check (14 Nov): the current project "taxcart-staging" is in Northeast Asia (Seoul), ap-northeast-2, on the Free plan. Test data only. A project's region cannot be changed, so the live (production) project should be a NEW Supabase project created in Sydney (ap-southeast-2), with the migrations re-run and a paid plan (Free projects pause after inactivity and have no daily backups). Confirm data-location expectations with the lawyer (questions 18-19).

- Ownership (Brad, 14 Nov): Brad handles deploys and support for the portal once it is used with clients, and will tell Claude if that changes. One Vercel seat (Brad) is enough. Priyank's operations team works the Submissions queue day to day.

- To do after the file check and template are final: write the ops how-to guide for Priyank's team (short intro, then bullets, with screenshots made from sample data). Covers sign-in, Submissions queue and statuses, files, questions, return PDF, nil returns, adding clients/filings/people, welcome email, View as client, common problems, and who to contact when Brad is away. Open items then: escalation contacts; whether to build staff delete/remove-access first.

- Priyank's Shopify template (Nov 2026): headings are Order name, Shipping country, Day, Gross sales, Discounts, Sales reversals, Net sales, Shipping charges, Return fees, Taxes, Total sales. The site now recognises "Day" as the date and "Order name" as the order. Priyank said no real client data should leave the TSG domain: use dummy data only. STILL TO CONFIRM with Priyank: which columns he treats as required (he mentioned highlighted columns in the first sample), and which amount counts.

- Required columns per Priyank (highlighted in the 54-column MOU template, 16 in total): TYPE, DIGITAL SERVICE, CHANNEL ID, INVOICE NUMBER, VAT COUNTRY, VAT REPORTING DATE, SHIPPING DATE, ARRIVAL COUNTRY, BUYER VAT NUMBER, BUYER VAT NUMBER COUNTRY, DEPARTURE COUNTRY, BUYER BILLING NAME, SKU, ITEM VAT RATE, ITEM GROSS UNIT PRICE, ORIGINAL CURRENCY. Note: ITEM NET PRICE and any quantity column are NOT in the highlighted list, but the site currently reads the amount from ITEM NET PRICE. The Shopify summary template (11 columns) does not contain most of these 16. OPEN: are both layouts accepted, and does Priyank's team convert Shopify files into the MOU layout? Buyer name and buyer VAT number are personal data: raise with the lawyer.

- Decision (Brad, 14 Nov): Priyank's 11-heading template is the standard. Extra columns are fine; if template columns are missing the site flags it (warning naming the missing columns). Date (Day), country (Shipping country) and amount (Net sales) are still required to send a file because the site cannot read it without them. The template is downloadable from the client's upload page. Brad will tell Claude if Priyank wants changes. The 54-column MOU highlighted list is parked for now.
