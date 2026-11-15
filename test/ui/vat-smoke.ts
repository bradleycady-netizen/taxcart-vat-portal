// Real-browser run of the VAT portal against the REAL request handlers (with in-memory stand-ins for the database and storage),
// served with the production Content-Security-Policy. Run: node test/ui/vat-smoke.ts   (needs Playwright; not part of `npm test`)
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getSession, logout, requestCode, verifyCode } from '../../src/http/handlers/auth.ts';
import { vatRoute } from '../../src/http/handlers/vat.ts';
import { T_A, T_B, U_A, U_B, USER_A, USER_STAFF, harness } from '../httpHelpers.ts';
import { vatDb } from '../vatFake.ts';

const require = createRequire(process.env.PLAYWRIGHT_DIR ? process.env.PLAYWRIGHT_DIR + '/' : import.meta.url);
const { chromium } = require('playwright');
const REPO = new URL('../../', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || '/tmp';
const csp = JSON.parse(readFileSync(REPO + 'vercel.json', 'utf8')).headers[0].headers.find((h: any) => h.key === 'Content-Security-Policy').value;

const tables: Record<string, any[]> = {
  tenants: [{ id: T_A, name: 'Northline Outdoor' }, { id: T_B, name: 'Beta Foods' }],
  tenant_members: [{ tenant_id: T_A, user_id: U_A, role: 'owner' }, { tenant_id: T_B, user_id: U_B, role: 'owner' }],
  vat_registrations: [
    { id: 'r1000000-0000-4000-8000-000000000001', tenant_id: T_A, scheme: 'ioss', country: 'PL', frequency: 'monthly', vat_number: null },
    { id: 'r1000000-0000-4000-8000-000000000002', tenant_id: T_A, scheme: 'uk_vat', country: 'GB', frequency: 'quarterly', vat_number: 'GB123456789' },
    { id: 'r1000000-0000-4000-8000-000000000003', tenant_id: T_A, scheme: 'oss', country: 'DE', frequency: 'quarterly', vat_number: null },
    { id: 'r2000000-0000-4000-8000-000000000001', tenant_id: T_B, scheme: 'oss', country: 'FR', frequency: 'quarterly', vat_number: null },
  ],
  vat_returns: [], vat_events: [],
};
const files = new Map<string, Uint8Array>();

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, ...(body.length ? { body } : {}) });
    const route = u.pathname === '/api/auth/request-code' ? requestCode : u.pathname === '/api/auth/verify-code' ? verifyCode : u.pathname === '/api/auth/logout' ? logout : u.pathname === '/api/session' ? getSession : u.pathname === '/api/vat' ? vatRoute : null;
    if (!route) { res.writeHead(404); return res.end('{}'); }
    const r = await route(request, h.deps);
    const out: Record<string, string | string[]> = {};
    r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
    out['set-cookie'] = r.headers.getSetCookie();
    res.writeHead(r.status, out);
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const p = REPO + 'public' + (u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname);
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  const type = p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.png') ? 'image/png' : 'text/html';
  res.writeHead(200, { 'content-type': type, 'content-security-policy': csp });
  res.end(readFileSync(p));
});
await new Promise<void>((r) => srv.listen(0, r));
const port = (srv.address() as any).port;
const base = `http://localhost:${port}`;
const h = harness({ configOverride: { APP_ORIGIN: base } });
const members = (id: string) => new Set(tables['tenant_members']!.filter((m) => m['user_id'] === id).map((m) => String(m['tenant_id'])));
h.deps.serviceDb = vatDb(tables, null, files);
h.deps.userDb = (token) => { const u = h.auth.validAccess.get(token); return vatDb(tables, u ? (u.isStaff ? null : members(u.id)) : new Set(), files); };

const problems: string[] = [];
const ok = (c: unknown, m: string) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const browser = await chromium.launch();
async function newPage(w = 1360, hgt = 900) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt } });
  const page = await ctx.newPage();
  page.on('console', (m: any) => { if (['error', 'warning'].includes(m.type()) && !/fonts\.(googleapis|gstatic)|Failed to load resource|ERR_/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e: Error) => problems.push('pageerror ' + e.message));
  return page;
}
async function signIn(page: any, email: string) {
  await page.goto(base + '/vat/');
  await page.waitForSelector('#email-form');
  await page.fill('#email', email); await page.click('button[type=submit]');
  await page.waitForSelector('#code-form');
  await page.fill('#code', '123456'); await page.click('button[type=submit]');
  await page.waitForSelector('.shell');
}

const CSV = 'Name,Created at,Shipping Country Code,Subtotal,Currency\n#1001,2026-09-03 10:00:00 +0200,DE,100.50,EUR\n#1002,2026-09-09,FR,250,EUR\n#1003,2026-09-12,US,40,EUR\n#1003,,,,\n';
const BAD = 'Name,Created at,Shipping Country Code,Subtotal,Currency\n#1001,2026-09-03,Narnia,100.50,EUR\n#1002,soon,FR,250,EUR\n';

// ---------------------------------------------------------------- client
const c = await newPage();
await c.goto(base + '/vat/');
await c.waitForSelector('#email-form');
await c.screenshot({ path: SHOTS + '/vat-login.png' });
ok((await c.locator('h2').innerText()) === 'Welcome back', 'login screen');
await signIn(c, USER_A.email);
await c.waitForSelector('.card');
ok((await c.locator('.who-name').innerText()) === 'Northline Outdoor', 'company shown');
ok((await c.locator('.card').count()) === 3, 'three filings are waiting for a sales file');
ok((await c.locator('.chip').count()) === 4, 'country chips (all + 3)');
ok((await c.locator('.flag svg').count()) > 5, 'flags drawn');
await c.screenshot({ path: SHOTS + '/vat-client-1.png', fullPage: true });

await c.locator('.card', { hasText: 'Poland' }).locator('[data-action=start-upload]').click();
await c.waitForSelector('#upload-form');
ok((await c.locator('#reg').inputValue()) === 'r1000000-0000-4000-8000-000000000001' && (await c.locator('#period').inputValue()) === '2026-09', 'upload page opens on Poland, Sep 2026');
await c.locator('#file-input').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(BAD) });
await c.waitForSelector('.issue.err');
ok((await c.locator('.issue.err').count()) === 2 && (await c.locator('[data-action=submit-file]').count()) === 0, 'a bad file shows errors and cannot be submitted');
await c.screenshot({ path: SHOTS + '/vat-upload-bad.png', fullPage: true });
await c.locator('#file-input').setInputFiles({ name: 'orders.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
await c.waitForSelector('[data-action=submit-file]');
ok((await c.locator('.issue.warn').count()) === 2 && (await c.locator('.issue.warn', { hasText: 'Taxcart template' }).count()) === 1 && (await c.locator('.mini tbody tr').count()) === 3, 'a good file shows a non-EU warning, a missing-template-columns note and the country table');
ok((await c.locator('a[href="/vat/Taxcart-sales-template.xlsx"]').count()) === 1, 'the upload page offers the Taxcart template download');
await c.screenshot({ path: SHOTS + '/vat-upload-good.png', fullPage: true });
await c.click('[data-action=submit-file]');
await c.waitForSelector('text=Submitted to Taxcart');
await c.click('[data-action=open-return]');
await c.waitForSelector('.timeline');
ok((await c.locator('.pill').first().innerText()) === 'Submitted', 'return opens as Submitted');
await c.click('[data-action=back]');
await c.waitForSelector('.steps');
ok((await c.locator('.card .pill').first().innerText()).length > 0, 'returns list shows the new return');

// ---------------------------------------------------------------- staff
const s = await newPage();
await signIn(s, USER_STAFF.email);
await s.waitForSelector('.row:not(.head)');
ok((await s.locator('.attn').first().innerText()) === 'New file uploaded', 'staff queue shows the new file');
await s.screenshot({ path: SHOTS + '/vat-staff-queue.png', fullPage: true });
await s.locator('.row:not(.head)').first().click();
await s.waitForSelector('#status-form');
ok((await s.locator('.mini tbody tr').count()) === 3, 'staff see what was uploaded');
await s.selectOption('#st', 'in_review'); await s.fill('#note', 'Looks fine so far'); await s.click('#status-form button[type=submit]');
await s.waitForSelector('text=Updated.');
await s.fill('#reply-body', 'Were the US orders duty paid?'); await s.click('#reply-form button[type=submit]');
await s.waitForSelector('text=Question sent');
await s.locator('#return-file').setInputFiles({ name: 'PL IOSS Sep.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
await s.waitForSelector('text=Return PDF attached.');
await s.screenshot({ path: SHOTS + '/vat-staff-detail.png', fullPage: true });
await s.selectOption('#st', 'return_prepared'); await s.click('#status-form button[type=submit]');
await s.waitForSelector('.pill:has-text("Return prepared")');
await s.click('[data-action=nav][data-view=clients]');
await s.waitForSelector('#client-form');
await s.fill('#cname', 'Test Client Ltd'); await s.click('#client-form button[type=submit]');
await s.waitForSelector('text=Test Client Ltd added');
await s.locator('.card', { hasText: 'Northline Outdoor' }).locator('[data-action=preview]').click();
await s.waitForSelector('.preview-bar');
ok((await s.locator('.preview-bar').innerText()).includes('Previewing Northline Outdoor'), 'staff can preview a client');
ok((await s.locator('.nav', { hasText: 'My returns' }).count()) === 1 && (await s.locator('.nav', { hasText: 'Submissions' }).count()) === 0, 'the preview shows the client screens');
await s.screenshot({ path: SHOTS + '/vat-preview.png', fullPage: true });
await s.click('.nav[data-action=exit-preview]');
await s.waitForSelector('#client-form');
ok((await s.locator('.tag', { hasText: 'VAT filing' }).count()) >= 1 && (await s.locator('.tag.muted').count()) >= 1, 'the Clients page labels VAT filings');
await s.click('[data-action=nav][data-view=countries]');
await s.waitForSelector('.row.cols4.static');
ok((await s.locator('.row.cols4.static').count()) === 4, 'countries page lists DE, FR, GB, PL');
await s.screenshot({ path: SHOTS + '/vat-staff-countries.png', fullPage: true });

// ---------------------------------------------------------------- client again
await c.click('[data-action=nav][data-view=returns]');
await c.waitForSelector('.callout');
ok((await c.locator('.callout').innerText()).includes('duty paid'), 'the client sees the question on the card');
await c.screenshot({ path: SHOTS + '/vat-client-2.png', fullPage: true });
await c.click('.callout [data-action=open-return]');
await c.waitForSelector('#reply-form');
await c.fill('#reply-body', 'Yes, all DDP.'); await c.click('#reply-form button[type=submit]');
await c.waitForSelector('text=Reply sent to Taxcart.');
await c.click('[data-action=nav][data-view=documents]');
await c.waitForSelector('[data-action=download][data-kind=return]');
ok(true, 'the finished return appears under Documents once prepared');
await c.click('[data-action=nav][data-view=questions]');
await c.waitForSelector('.empty');
ok((await c.locator('.empty').innerText()).includes('Nothing needs your attention'), 'questions page is clear after replying');

// ---------------------------------------------------------------- nil return
await c.click('[data-action=nav][data-view=upload]');
await c.waitForSelector('#upload-form');
await c.selectOption('#period', '2026-08');
await c.click('[data-action=ask-nil]');
await c.waitForSelector('[data-action=confirm-nil]');
ok((await c.locator('.info-box').innerText()).includes('Confirm no sales'), 'the client is asked to confirm a nil return');
await c.screenshot({ path: SHOTS + '/vat-nil-confirm.png', fullPage: true });
await c.click('[data-action=confirm-nil]');
await c.waitForSelector('text=No sales recorded');
await c.click('[data-action=open-return]');
await c.waitForSelector('.timeline');
ok((await c.locator('.tag.muted', { hasText: 'No sales' }).count()) >= 1 && (await c.locator('[data-kind=upload]').count()) === 0, 'a nil return is labelled and has no sales file');

// ---------------------------------------------------------------- phone width
const m = await newPage(390, 800);
await signIn(m, USER_A.email);
await m.waitForSelector('.card');
ok(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scrolling at phone width');
await m.screenshot({ path: SHOTS + '/vat-phone.png' });

ok(problems.length === 0, 'no console errors or Content-Security-Policy violations' + (problems.length ? ': ' + problems.join(' | ') : ''));
await browser.close();
srv.close();
