// Real-browser check of the portal pages against a fake API, with the production Content-Security-Policy applied.
// Run: node test/ui/smoke.mjs   (not part of `npm test` because it needs a browser)
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
// Needs Playwright (npm i -D playwright, or any install that `require('playwright')` can find).
const require = createRequire(process.env.PLAYWRIGHT_DIR ? process.env.PLAYWRIGHT_DIR + '/' : import.meta.url);
const { chromium } = require('playwright');
const REPO = new URL('../../', import.meta.url).pathname;
const ROOT = REPO + 'public';
const csp = JSON.parse(readFileSync(REPO + 'vercel.json','utf8')).headers[0].headers.find(h=>h.key==='Content-Security-Policy').value;
let signedIn = false; const log = [];
const T = 't0000000-0000-4000-8000-000000000001';
const filings = [
 {id:'f1',jurisdiction:'TX',periodCode:'2026-Q3',periodName:'Q3 2026',frequency:'quarterly',dueOn:'2026-10-20',isCompleted:true,estimatedTaxDue:1200.5,amountPaid:1200.5,documents:[{kind:'return',href:'/api/documents?filing=f1&kind=return'}]},
 {id:'f2',jurisdiction:'CA',periodCode:'2026-09',periodName:'Sep 2026',frequency:'monthly',dueOn:'2026-10-31',isCompleted:false,estimatedTaxDue:300,amountPaid:null,documents:[]},
 {id:'f3',jurisdiction:'<b>NY</b>',periodCode:'x',periodName:'<i>x</i>',frequency:'other',dueOn:'2026-09-01',isCompleted:false,estimatedTaxDue:null,amountPaid:null,documents:[]}];
const send=(res,s,b,h={})=>{res.writeHead(s,{'content-type':'application/json',...h});res.end(JSON.stringify(b));};
const srv = http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x'); log.push(req.method+' '+u.pathname);
  if(u.pathname.startsWith('/api/')){
    if(u.pathname==='/api/auth/request-code') return send(res,200,{ok:true});
    if(u.pathname==='/api/auth/verify-code'){ let b='';req.on('data',d=>b+=d);req.on('end',()=>{ if(JSON.parse(b).code==='123456'){signedIn=true;send(res,200,{ok:true,user:{email:'a@b.co',isStaff:false}});} else send(res,401,{error:{code:'invalid_code',message:'That code is incorrect or has expired.'}});}); return; }
    if(u.pathname==='/api/auth/logout'){signedIn=false;return send(res,200,{ok:true});}
    if(!signedIn) return send(res,401,{error:{code:'unauthenticated',message:'Please sign in.'}});
    if(u.pathname==='/api/session') return send(res,200,{user:{email:'a@b.co',isStaff:false},tenants:[{id:T,name:'Acme Pty Ltd',products:[{product:'us_sales_tax',lastSyncedAt:'2026-10-22T01:00:00Z',syncStatus:'stale'},{product:'eu_vat',lastSyncedAt:null,syncStatus:'pending'}]}]});
    if(u.pathname==='/api/filings') return send(res,200,{filings: u.searchParams.get('product')==='eu_vat'?[]:filings,sync:u.searchParams.get('product')==='eu_vat'?{asOf:null,status:'pending'}:{asOf:'2026-10-22T01:00:00Z',status:'stale'},page:{limit:25,offset:0,hasMore:false}});
    if(u.pathname==='/api/registrations') return send(res,200,{registrations:[{jurisdiction:'TX',taxId:'123',startedAt:'2025-01-01',endedAt:null,frequency:'quarterly'}],sync:{asOf:'2026-10-22T01:00:00Z',status:'ok'},page:{limit:25,offset:0,hasMore:false}});
    return send(res,404,{error:{code:'not_found',message:'Not found.'}});
  }
  const p=ROOT+(u.pathname==='/'?'/index.html':u.pathname);
  if(!existsSync(p)) {res.writeHead(404);return res.end();}
  const type=p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html';
  res.writeHead(200,{'content-type':type,'content-security-policy':csp}); res.end(readFileSync(p));
}).listen(0);
const port=srv.address().port; const base=`http://localhost:${port}`;
const browser = await chromium.launch(); const page = await browser.newPage({viewport:{width:1280,height:800}});
const problems=[]; page.on('console',m=>{ if(['error','warning'].includes(m.type()) && !/fonts\.(googleapis|gstatic)|Failed to load resource|ERR_/.test(m.text())) problems.push(m.text());}); page.on('pageerror',e=>problems.push('pageerror '+e.message));
const ok=(c,m)=>{ if(!c){console.log('FAIL',m);process.exitCode=1;} else console.log('ok  ',m); };
await page.goto(base);
await page.waitForSelector('#email-form');
ok(await page.locator('h1').innerText()==='Sign in','unauthenticated visitor lands on login');
await page.fill('#email','a@b.co'); await page.click('button[type=submit]');
await page.waitForSelector('#code-form');
await page.fill('#code','000000'); await page.click('button[type=submit]');
await page.waitForSelector('.form-error'); ok((await page.locator('.form-error').innerText()).includes('incorrect'),'wrong code shows message, stays on login');
await page.fill('#code','123456'); await page.click('button[type=submit]');
await page.waitForSelector('.shell'); await page.waitForSelector('.hero-stat');
ok((await page.locator('.viewer-company').innerText())==='Acme Pty Ltd','company name from session');
ok(await page.locator('.product-option').count()===2,'product switcher shows both products');
ok(await page.locator('.login-wrap').count()===0 && await page.locator('.hero-chip').count()===3,'dashboard hero and three chips shown');
ok((await page.locator('.nav-item').allInnerTexts()).join('|')==='Dashboard|Filings|Nexus tracker|Registrations','nav matches the original design');
ok((await page.locator('.fp-seg').first().evaluate(e=>e.style.width))!=='' ,'tracker bar widths applied from script under the CSP');
ok((await page.content()).includes('Economic nexus') && !/Zamp/i.test(await page.locator('body').innerText()),'nexus card is a plain placeholder, no vendor name');
await page.click('[data-view=nexus]'); await page.waitForSelector('.placeholder'); ok((await page.locator('.placeholder').innerText()).includes('Nexus tracking'),'nexus page placeholder');
await page.click('[data-view=overview]'); await page.waitForSelector('.hero-stat');
ok((await page.locator('.sync-note.stale').innerText()).includes('may be out of date'),'stale note shown');
await page.screenshot({path:(process.env.SHOTS||'.')+'/overview.png'});
await page.click('[data-view=filings]'); await page.waitForSelector('table.data');
ok(await page.locator('tbody tr').count()===3,'filings rows');
ok((await page.locator('tbody').innerHTML()).includes('&lt;b&gt;NY&lt;/b&gt;') && await page.locator('tbody b').count()===0,'hostile text rendered inert');
ok(await page.locator('a.dl-link').getAttribute('href')==='/api/documents?filing=f1&kind=return','download link points at our endpoint');
await page.screenshot({path:(process.env.SHOTS||'.')+'/filings.png'});
await page.click('[data-view=registrations]');  await page.waitForSelector('td[data-label="Registration number"]');
ok((await page.locator('tbody').innerText()).includes('123'),'registrations rows');
await page.click('[data-view=filings]'); await page.waitForSelector('tbody tr'); await page.click('[data-product=eu_vat]'); await page.waitForSelector('.sync-note.pending');
ok((await page.locator('.product-option.active .product-name').innerText())==='VAT','switching to VAT works and shows pending state');
await page.setViewportSize({width:390,height:800}); await page.screenshot({path:(process.env.SHOTS||'.')+'/mobile.png'});
await page.setViewportSize({width:1280,height:800});
await page.click('[data-action=logout]'); await page.waitForSelector('#email-form');
ok(signedIn===false,'sign out calls the server and returns to login');
// session ending mid-use
signedIn=true; await page.reload(); await page.waitForSelector('.shell'); signedIn=false; await page.click('[data-view=filings]'); await page.waitForSelector('#email-form');
ok((await page.locator('.form-info').innerText()).includes('session has ended'),'401 during use returns to login with a message');
ok(problems.length===0,'no console errors / CSP violations '+JSON.stringify(problems));
await browser.close(); srv.close();
