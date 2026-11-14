// HTML for every screen of the VAT portal. Pure functions: state in, markup out. All text from the server is escaped.
import { esc, STATUSES, STATUS_LABEL, STEP_LABEL, STATUS_CLASS, FREQ_LABEL, fmtDate, fmtDateTime, dueText, daysUntil, money, fileSize, isOpen } from './format.js';
import { flag } from './flags.js';

const svg = (body, size = 18, stroke = 'currentColor', w = 1.9) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const I = {
  returns: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>'),
  upload: svg('<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  folder: svg('<path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>'),
  queue: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  people: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.7c1.6.7 2.7 2.3 3 5.3"/>'),
  globe: svg('<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19"/><path d="M12 2.5c2.6 2.7 4 6 4 9.5s-1.4 6.8-4 9.5c-2.6-2.7-4-6-4-9.5s1.4-6.8 4-9.5z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 16, 'currentColor', 2.4),
  download: svg('<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>', 15, 'currentColor', 2.2),
  alert: svg('<circle cx="12" cy="12" r="9.5"/><path d="M12 7.5V13M12 16.5v.01"/>', 20, '#8A4B00', 2),
  tick: svg('<path d="m5 12 5 5 9-10"/>', 16, '#8FF0BF', 2.6),
  arrow: svg('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>', 17, 'currentColor', 2.4),
  good: svg('<circle cx="12" cy="12" r="10" fill="#1B8A58" stroke="none"/><path d="m7.5 12.5 3 3 6-6.5" stroke="#fff"/>', 24, '#fff', 2.4),
  back: svg('<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>'),
  bad: svg('<circle cx="12" cy="12" r="10" fill="#C23030" stroke="none"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff"/>', 24, '#fff', 2.4),
};

const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const pill = (status) => `<span class="pill ${STATUS_CLASS[status] ?? 's-none'}"><i></i>${esc(STATUS_LABEL[status] ?? status)}</span>`;
const spinner = (text = 'Loading…') => `<div class="loading" role="status">${esc(text)}</div>`;
export const errorBox = (text, retry = true) => `<div class="error-box" role="alert">${esc(text)}${retry ? ' <button class="btn small ghost" data-action="reload-data">Try again</button>' : ''}</div>`;
const empty = (title, text) => `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`;

// ------------------------------------------------------------------ brand and shell

const logoBox = '<div class="logo-box"><img src="/vat/taxcart-logo.png" alt="Taxcart: global tax compliance" width="190" height="55"></div>';

export function shell({ nav, who, body, footer = '' }) {
  return `<div class="shell"><aside class="side">${logoBox}${who}<nav aria-label="Main">${nav}</nav><div class="side-foot">${footer}</div></aside><main class="main" id="main" tabindex="-1"><div class="wrap">${body}</div></main></div>`;
}
export const navItem = (key, label, icon, active, badge = 0) =>
  `<button class="nav${active ? ' on' : ''}" data-action="nav" data-view="${key}" ${active ? 'aria-current="page"' : ''}>${icon}<span class="grow">${esc(label)}</span>${badge > 0 ? `<span class="nav-badge">${badge}</span>` : ''}</button>`;
export const whoBox = (name, sub) => `<div class="who"><div class="who-mark">${esc(initials(name))}</div><div><div class="who-name">${esc(name)}</div><div class="who-sub">${esc(sub)}</div></div></div>`;
export const signOut = (email) => `${esc(email)}<br><button data-action="logout">Sign out</button>`;

export const previewBanner = (name) => `<div class="preview-bar" role="status"><div><strong>Previewing ${esc(name)}</strong> as the client sees it. Anything you submit or reply to here is recorded as the client's own, with your name in the audit trail.</div><button class="btn ghost small" data-action="exit-preview">Exit preview</button></div>`;

// ------------------------------------------------------------------ sign in

export function loginScreen(l) {
  const err = l.error ? `<div class="error-box" role="alert">${esc(l.error)}</div>` : '';
  const info = l.info ? `<div class="info-box" role="status">${esc(l.info)}</div>` : '';
  const emailStep = l.step === 'email';
  const form = emailStep
    ? `<form id="email-form" novalidate><label class="field-label" for="email">Work email</label><input class="field" id="email" name="email" type="email" inputmode="email" autocomplete="username" placeholder="you@company.com" value="${esc(l.email)}" required autofocus>${err}${info}<button class="btn" type="submit" ${l.busy ? 'disabled' : ''}>${l.busy ? 'Sending…' : `Send me a code${I.arrow}`}</button><p class="fine">Access is by invitation. Not set up yet? Contact your Taxcart team.</p></form>`
    : `<form id="code-form" novalidate><label class="field-label" for="code">Sign-in code</label><input class="field" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" placeholder="123456" required autofocus>${err}${info}<button class="btn" type="submit" ${l.busy ? 'disabled' : ''}>${l.busy ? 'Checking…' : 'Sign in'}</button><p class="fine">If ${esc(l.email)} is registered, a code is on its way. It expires in a few minutes.</p><button class="linkish" type="button" data-action="login-back">Use a different email</button></form>`;
  const row = (code, title, sub, cls, status) => `<div class="srow">${flag(code)}<div class="grow"><div class="hd">${title}</div><small>${sub}</small></div><span class="st ${cls}">${status}</span></div>`;
  return `<div class="login"><section class="login-art">${logoBox}<div class="login-mid"><div class="login-copy"><h1>Your VAT,<br>filed properly.</h1><p>Send us your sales. We prepare and file your returns across the EU and UK, and you can see exactly where each one stands.</p><div class="ticks"><span>${I.tick}Specialist-led filings</span><span>${I.tick}Clear status at every step</span><span>${I.tick}Your files stay private</span></div></div>
    <div class="sched" aria-hidden="true"><div class="sched-head"><span class="hd">Your filing schedule</span><span>Example</span></div>${row('DE', 'Germany OSS', 'Q3 return', 'good', 'Filed')}${row('GB', 'UK VAT', 'Q3 return', 'good', 'Filed')}${row('PL', 'Poland IOSS', 'October return', 'soon', 'Due soon')}${row('IT', 'Italy OSS', 'Q4 return', 'now', 'In progress')}<div class="sched-foot">Returns tracked. Deadlines handled.</div></div></div></section>
    <section class="login-form-side"><div class="login-form"><h2>${emailStep ? 'Welcome back' : 'Check your email'}</h2><p class="sub">${emailStep ? 'Enter your email and we will send you a one-time sign-in code. No password to remember.' : 'Enter the code we sent you.'}</p>${form}</div></section></div>`;
}

// ------------------------------------------------------------------ client: returns

const stepBar = (status) => {
  const at = STATUSES.indexOf(status);
  return `<div class="steps" role="img" aria-label="Progress: ${esc(STATUS_LABEL[status])}">${STATUSES.map((s, i) => `<div><div class="seg${i < at ? ' done' : i === at ? ' cur' : ''}"></div><div class="steplab${i === at ? ' cur' : ''}">${esc(STEP_LABEL[s])}</div></div>`).join('')}</div>`;
};

const STATUS_NOTE = {
  submitted: 'We have your file. Taxcart will confirm once it has been picked up.',
  received: 'Your file has been received and is in the queue.',
  in_review: 'Our team is checking your sales and preparing the return.',
  return_prepared: 'Your return has been prepared. Filing is next.',
  filed: 'Your return has been filed. Your confirmation and payment details will appear here once complete.',
  complete: '',
};

function retHeader(r, staff) {
  const when = r.status === 'filed' || r.status === 'complete' ? (r.filedAt ? `Filed ${fmtDate(r.filedAt.slice(0, 10))}` : '') : r.dueOn ? `Due ${fmtDate(r.dueOn)}` : '';
  return `<div class="ret-id">${flag(r.country)}<div><div class="hd ret-title">${esc(r.countryName)} · ${esc(r.periodLabel)}</div><div class="ret-meta">${staff ? `<span class="strong">${esc(r.tenantName ?? '')}</span>` : ''}<span class="tag">${esc(r.schemeLabel)}</span>${r.nil ? '<span class="tag muted">No sales</span>' : ''}${when ? `<span>${esc(when)}</span>` : ''}</div></div></div>`;
}

export function returnCard(r) {
  const pdf = r.returnFile ? `<button class="btn ghost small" data-action="download" data-id="${esc(r.id)}" data-kind="return">${I.download}VAT return (PDF)</button>` : '';
  const callout = r.awaitingClient
    ? `<div class="callout">${I.alert}<div class="callout-body"><div class="callout-title">Taxcart has a question</div><p>${esc(r.question?.body ?? 'Please check the conversation on this return.')}</p><div class="row-actions"><button class="btn small" data-action="open-return" data-id="${esc(r.id)}">Reply</button></div></div></div>`
    : STATUS_NOTE[r.status] ? `<p class="note">${esc(STATUS_NOTE[r.status])}</p>` : '';
  return `<section class="card" aria-label="${esc(r.countryName)} ${esc(r.periodLabel)}"><div class="ret-top">${retHeader(r, false)}<div class="ret-right">${pdf}${pill(r.status)}</div></div>${stepBar(r.status)}${callout}<div class="row-actions note"><button class="btn ghost small" data-action="open-return" data-id="${esc(r.id)}">Details</button></div></section>`;
}

function waitingCard(reg, p) {
  return `<section class="card" aria-label="${esc(reg.countryName)} ${esc(p.label)} not yet submitted"><div class="ret-top"><div class="ret-id">${flag(reg.country)}<div><div class="hd ret-title">${esc(reg.countryName)} · ${esc(p.label)}</div><div class="ret-meta"><span class="tag">${esc(reg.schemeLabel)}</span><span class="tag">${esc(FREQ_LABEL[reg.frequency])}</span><span>Due ${esc(fmtDate(p.dueOn))}</span></div></div></div><div class="ret-right"><button class="btn small" data-action="start-upload" data-reg="${esc(reg.id)}" data-period="${esc(p.code)}">${I.upload}Upload sales file</button><span class="pill s-none"><i></i>Waiting for your sales file</span></div></div></section>`;
}

export function clientReturns(c, filter, now) {
  if (c.status === 'loading') return head('VAT compliance', 'Your VAT returns', '') + spinner();
  if (c.status === 'error') return head('VAT compliance', 'Your VAT returns', '') + errorBox(c.error);
  const regs = c.registrations, returns = c.returns;
  const open = returns.filter(isOpen);
  const waiting = [];
  for (const reg of regs) { const p = reg.periods.find((x) => !x.returnId); if (p && reg.periods[0] && reg.periods[0].code === p.code) waiting.push({ reg, p }); }
  const upcoming = [...open.filter((r) => r.dueOn).map((r) => ({ due: r.dueOn, label: `${r.countryName} ${r.schemeLabel}` })), ...waiting.map((w) => ({ due: w.p.dueOn, label: `${w.reg.countryName} ${w.reg.schemeLabel}` }))].filter((x) => daysUntil(x.due, now) !== null).sort((a, b) => (a.due < b.due ? -1 : 1));
  const next = upcoming[0];
  const questions = returns.filter((r) => r.awaitingClient).length;
  const thisYear = String(now.getFullYear());
  const filed = returns.filter((r) => !isOpen(r) && String(r.periodEnd ?? '').startsWith(thisYear)).length;
  const countries = [...new Map([...regs.map((r) => [r.country, r.countryName]), ...returns.map((r) => [r.country, r.countryName])]).entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1));
  const shown = (x) => !filter || x === filter;
  const cards = [
    ...waiting.filter((w) => shown(w.reg.country)).map((w) => waitingCard(w.reg, w.p)),
    ...returns.filter((r) => shown(r.country)).map(returnCard),
  ];
  const stats = `<div class="stats">
    <div class="stat hero"><div class="stat-label">Next deadline</div><div class="stat-num">${next ? esc(fmtDate(next.due, true)) : '—'}</div><div class="stat-sub">${next ? `${esc(next.label)} · ${daysUntil(next.due, now) < 0 ? `${-daysUntil(next.due, now)} days overdue` : daysUntil(next.due, now) === 0 ? 'today' : `${daysUntil(next.due, now)} days`}` : 'Nothing due'}</div></div>
    <div class="stat"><div class="stat-label">In progress</div><div class="stat-num">${open.length}</div><div class="stat-sub">with our team</div></div>
    <div class="stat${questions ? ' warn' : ''}"><div class="stat-label">Needs your reply</div><div class="stat-num">${questions}</div><div class="stat-sub">${questions === 1 ? 'question' : 'questions'} from Taxcart</div></div>
    <div class="stat"><div class="stat-label">Filed this year</div><div class="stat-num">${filed}</div><div class="stat-sub">${filed === 1 ? 'return' : 'returns'}</div></div></div>`;
  const chips = countries.length > 1
    ? `<div class="chips" role="group" aria-label="Filter by country"><button class="chip all${!filter ? ' on' : ''}" data-action="filter-country" data-code="">All countries</button>${countries.map(([code, name]) => `<button class="chip${filter === code ? ' on' : ''}" data-action="filter-country" data-code="${esc(code)}">${flag(code, true)}${esc(name)}</button>`).join('')}</div>`
    : '<div class="chips"></div>';
  const body = regs.length === 0
    ? empty('Your VAT filings are not set up yet', 'Your Taxcart representative will set up your filings. You will be able to upload sales here as soon as they have.')
    : cards.length ? `<div class="list">${cards.join('')}</div>` : empty('Nothing here yet', 'Your returns will appear here as soon as you submit your first sales file.');
  return head('VAT compliance', 'Your VAT returns', 'Upload your sales, follow every return from submission to filing, and download the paperwork when it is done.', regs.length ? `<button class="btn" data-action="nav" data-view="upload">${I.plus}New submission</button>` : '') + (regs.length ? stats : '') + chips + body;
}

function head(eyebrow, title, lede, action = '') {
  return `<div class="head"><div><div class="eyebrow">${esc(eyebrow)}</div><h1 class="title">${esc(title)}</h1>${lede ? `<p class="lede">${esc(lede)}</p>` : ''}</div>${action}</div>`;
}

// ------------------------------------------------------------------ client: new submission

export function issueList(items, kind) {
  if (!items.length) return '';
  return `<ul class="issue-list">${items.map((i) => `<li class="issue ${kind}">${esc(i.message)}${i.rows?.length ? `<small>Check row${i.rows.length > 1 ? 's' : ''} ${esc(i.rows.join(', '))}${i.rows.length >= 5 ? ' and others' : ''} in your file.</small>` : ''}</li>`).join('')}</ul>`;
}

function checkPanel(u) {
  const r = u.result;
  if (u.status === 'checking') return `<div class="card">${spinner('Checking your file…')}</div>`;
  if (!r) return '';
  const s = r.summary;
  const headline = r.ok ? `${I.good}<span>${r.warnings.length ? 'Your file can be submitted, with a few things to look at' : 'Your file looks good'}</span>` : `${I.bad}<span>Your file needs fixing before it can be submitted</span>`;
  const sum = s ? `<div class="sum-grid"><div class="sum-box"><span>Orders read</span><b>${s.rows.toLocaleString('en-GB')}</b></div>${s.totals.map((t) => `<div class="sum-box"><span>Total sales${t.currency !== '—' ? ` (${esc(t.currency)})` : ''}</span><b>${esc(money(t.amount, ''))}</b></div>`).join('')}<div class="sum-box"><span>Dates</span><b>${esc(fmtDate(s.dateFrom, true))} – ${esc(fmtDate(s.dateTo, true))}</b></div></div>
    <table class="mini"><caption class="visually-hidden">Sales by destination country</caption><thead><tr><th>Destination</th><th class="num">Orders</th><th class="num">Sales</th></tr></thead><tbody>${s.byCountry.slice(0, 12).map((c) => `<tr><td><span class="cell-flag">${flag(c.code, true)}${esc(c.name)}</span></td><td class="num">${c.rows}</td><td class="num">${esc(money(c.amount, ''))}</td></tr>`).join('')}</tbody></table>
    <p class="note">We read the amount from “${esc(s.columns.amount)}”, the date from “${esc(s.columns.date)}” and the country from “${esc(s.columns.country)}”.</p>` : '';
  return `<div class="card"><div class="check-head">${headline}</div>${issueList(r.errors, 'err')}${issueList(r.warnings, 'warn')}${sum}</div>`;
}

export function uploadPage(c, u) {
  if (c.status === 'loading') return head('VAT compliance', 'New submission', '') + spinner();
  if (c.status === 'error') return head('VAT compliance', 'New submission', '') + errorBox(c.error);
  const regs = c.registrations;
  if (!regs.length) return head('VAT compliance', 'New submission', '') + empty('Your VAT filings are not set up yet', 'Your Taxcart representative will set up your filings first.');
  if (u.status === 'done') {
    return head('VAT compliance', 'New submission', '') + `<div class="card"><div class="check-head">${I.good}<span>${u.nil ? 'No sales recorded' : u.replaced ? 'File replaced' : 'Submitted to Taxcart'}</span></div><p class="note">Thank you. Our team will pick it up shortly and you can follow progress on the return. If we have a question, it will appear on your dashboard.</p>${issueList(u.result?.warnings ?? [], 'warn')}<div class="row-actions note"><button class="btn" data-action="open-return" data-id="${esc(u.doneId)}">View this return</button><button class="btn ghost" data-action="upload-another">Submit another file</button></div></div>`;
  }
  const reg = regs.find((r) => r.id === u.regId) ?? regs[0];
  const periods = reg.periods;
  const period = periods.find((p) => p.code === u.period) ?? periods.find((p) => !p.returnId) ?? periods[0];
  const locked = period.returnId && period.status !== 'submitted';
  const filtered = reg.periods.filter(() => true);
  const form = `<div class="card"><form id="upload-form" novalidate><div class="form-grid">
    <div><label class="field-label" for="reg">Filing</label><select class="field" id="reg" name="reg" data-action-change="pick-reg">${regs.map((r) => `<option value="${esc(r.id)}" ${r.id === reg.id ? 'selected' : ''}>${esc(r.countryName)} · ${esc(r.schemeLabel)} (${esc(FREQ_LABEL[r.frequency].toLowerCase())})</option>`).join('')}</select></div>
    <div><label class="field-label" for="period">Period</label><select class="field" id="period" name="period" data-action-change="pick-period">${filtered.map((p) => `<option value="${esc(p.code)}" ${p.code === period.code ? 'selected' : ''}>${esc(p.label)}${p.returnId ? (p.status === 'submitted' ? ' — replace file' : ' — already with Taxcart') : ''}</option>`).join('')}</select></div></div>
    ${locked ? `<div class="info-box">Taxcart has already started on this period. If something has changed, please send a message on the return instead.</div>` : `<div class="form-row"><label class="drop${u.over ? ' over' : ''}" for="file-input" data-drop="1"><strong>${u.file ? esc(u.file.name) : 'Choose your sales file'}</strong><span>${u.file ? `${esc(fileSize(u.file.size))} · choose a different file to replace it` : 'Drag it here or click to browse. CSV or Excel (.xlsx), up to 4 MB.'}</span></label><input class="visually-hidden" id="file-input" type="file" accept=".csv,.xlsx" tabindex="-1"></div><p class="note">Not sure how to lay out your file? <a href="/vat/Taxcart-sales-template.xlsx" download>Download the Taxcart template (Excel)</a>. Your own export works too if it has an order date, a destination country and a sales amount.</p>`}
    ${!locked && !period.returnId ? (u.nilAsk ? `<div class="info-box"><strong>Confirm no sales for ${esc(period.label)}?</strong><p class="note">We will record a nil return for ${esc(reg.countryName)} · ${esc(reg.schemeLabel)}. Only do this if you had no sales in this period.</p><div class="row-actions note"><button class="btn small" type="button" data-action="confirm-nil" ${u.status === 'submitting' ? 'disabled' : ''}>${u.status === 'submitting' ? 'Sending…' : 'Yes, no sales'}</button><button class="btn ghost small" type="button" data-action="cancel-nil">Cancel</button></div></div>` : `<div class="row-actions note"><button class="btn ghost small" type="button" data-action="ask-nil">No sales this period</button></div>`) : ''}
    ${u.error ? `<div class="error-box" role="alert">${esc(u.error)}</div>` : ''}</form></div>`;
  const submit = u.result?.ok && u.status !== 'checking'
    ? `<div class="row-actions"><button class="btn" data-action="submit-file" ${u.status === 'submitting' ? 'disabled' : ''}>${u.status === 'submitting' ? 'Submitting…' : 'Submit to Taxcart'}</button><span class="note">Due ${esc(fmtDate(period.dueOn))}</span></div>` : '';
  return head('VAT compliance', 'New submission', 'Choose the filing and period, add your sales file, and we will check it before you send it.') + `<div class="stack section-gap">${form}${checkPanel(u)}${submit}</div>`;
}

// ------------------------------------------------------------------ client: questions and documents

export function questionsPage(c) {
  if (c.status === 'loading') return head('VAT compliance', 'Questions', '') + spinner();
  if (c.status === 'error') return head('VAT compliance', 'Questions', '') + errorBox(c.error);
  const open = c.returns.filter((r) => r.awaitingClient);
  const body = open.length
    ? `<div class="list">${open.map((r) => `<section class="card"><div class="ret-top">${retHeader(r, false)}${pill(r.status)}</div><div class="callout">${I.alert}<div class="callout-body"><div class="callout-title">Taxcart has a question</div><p>${esc(r.question?.body ?? '')}</p><div class="row-actions"><button class="btn small" data-action="open-return" data-id="${esc(r.id)}">Reply</button></div></div></div></section>`).join('')}</div>`
    : empty('Nothing needs your attention', 'When Taxcart has a question about one of your returns, it will appear here.');
  return head('VAT compliance', 'Questions', 'Questions from the Taxcart team that need an answer from you.') + `<div class="section-gap">${body}</div>`;
}

export function documentsPage(c) {
  if (c.status === 'loading') return head('VAT compliance', 'Documents', '') + spinner();
  if (c.status === 'error') return head('VAT compliance', 'Documents', '') + errorBox(c.error);
  const rows = c.returns.filter((r) => r.upload || r.returnFile);
  const body = rows.length
    ? `<div class="list">${rows.map((r) => `<section class="card"><div class="ret-top">${retHeader(r, false)}<div class="ret-right">${r.upload ? `<button class="btn ghost small" data-action="download" data-id="${esc(r.id)}" data-kind="upload">${I.download}Your sales file (${esc(fileSize(r.upload.bytes))})</button>` : ''}${r.returnFile ? `<button class="btn small" data-action="download" data-id="${esc(r.id)}" data-kind="return">${I.download}VAT return (PDF)</button>` : ''}</div></div></section>`).join('')}</div>`
    : empty('No documents yet', 'Your uploaded sales files and finished returns will be kept here.');
  return head('VAT compliance', 'Documents', 'Everything you have sent us, and every return we have prepared for you.') + `<div class="section-gap">${body}</div>`;
}

// ------------------------------------------------------------------ return detail (client and staff)

const KIND_TEXT = {
  submitted: () => 'Sales file submitted',
  file_replaced: () => 'Sales file replaced',
  status: (e) => `Status changed to ${STATUS_LABEL[e.status] ?? e.status}`,
  question: () => 'Question from Taxcart',
  reply: () => 'Reply',
  return_attached: () => 'Return PDF attached',
  due_changed: (e) => `Due date set to ${fmtDate(e.body)}`,
};

function timeline(events, staff) {
  if (!events.length) return '<p class="note">Nothing has happened yet.</p>';
  const who = (e) => (e.side === 'staff' ? (staff ? 'Taxcart team' : 'Taxcart') : staff ? 'Client' : 'You');
  return `<ol class="timeline">${[...events].reverse().map((e) => `<li class="tl"><span class="tl-dot${e.side === 'staff' ? ' staff' : ''}${e.kind === 'question' ? ' q' : ''}"></span><div class="tl-text"><strong>${esc((KIND_TEXT[e.kind] ?? (() => e.kind))(e))}</strong>${e.body && e.kind !== 'due_changed' ? `<p>${esc(e.body)}</p>` : ''}<div class="tl-when">${esc(who(e))} · ${esc(fmtDateTime(e.at))}</div></div></li>`).join('')}</ol>`;
}

function uploadSummaryCard(us) {
  const s = us?.summary;
  if (!s) return '';
  return `<div class="card"><h3>What was uploaded</h3><div class="sum-grid"><div class="sum-box"><span>Orders read</span><b>${s.rows.toLocaleString('en-GB')}</b></div>${s.totals.map((t) => `<div class="sum-box"><span>Total${t.currency !== '—' ? ` (${esc(t.currency)})` : ''}</span><b>${esc(money(t.amount, ''))}</b></div>`).join('')}</div>${issueList(us.warnings ?? [], 'warn')}<table class="mini"><thead><tr><th>Destination</th><th class="num">Orders</th><th class="num">Sales</th></tr></thead><tbody>${s.byCountry.slice(0, 30).map((c) => `<tr><td><span class="cell-flag">${flag(c.code, true)}${esc(c.name)}</span></td><td class="num">${c.rows}</td><td class="num">${esc(money(c.amount, ''))}</td></tr>`).join('')}</tbody></table><p class="note">Read from: amount “${esc(s.columns.amount)}”, date “${esc(s.columns.date)}”, country “${esc(s.columns.country)}”.</p></div>`;
}

export function detailPage(d, staff) {
  const back = `<button class="back" data-action="back">← Back</button>`;
  if (d.status === 'loading') return back + spinner();
  if (d.status === 'error') return back + errorBox(d.error);
  const r = d.ret;
  const files = `<div class="card"><h3>Files</h3><div class="stack">${r.nil ? '<div><div class="strong">No sales this period</div><div class="note">The client confirmed they had no sales in this period (a nil return).</div></div>' : ''}${r.upload ? `<div><div class="strong">Sales file</div><div class="note">${esc(r.upload.name)} · ${esc(fileSize(r.upload.bytes))} · ${r.upload.rows ?? '?'} orders</div><div class="row-actions note"><button class="btn ghost small" data-action="download" data-id="${esc(r.id)}" data-kind="upload">${I.download}Download</button></div></div>` : ''}${r.returnFile ? `<div><div class="strong">VAT return</div><div class="note">${esc(r.returnFile.name)} · ${esc(fileSize(r.returnFile.bytes))}</div><div class="row-actions note"><button class="btn small" data-action="download" data-id="${esc(r.id)}" data-kind="return">${I.download}Download (PDF)</button></div></div>` : staff ? '' : '<p class="note">Your VAT return will appear here once it has been prepared.</p>'}</div></div>`;
  const talk = `<div class="card"><h3>${staff ? 'Conversation' : 'Messages'}</h3><form id="reply-form" novalidate><label class="visually-hidden" for="reply-body">${staff ? 'Message to the client' : 'Your message'}</label><textarea class="field" id="reply-body" name="body" maxlength="2000" placeholder="${staff ? 'Ask the client a question…' : 'Write a reply or add a note for Taxcart…'}"></textarea><div class="row-actions note"><button class="btn small" type="submit" ${d.busy ? 'disabled' : ''}>${staff ? 'Send question' : 'Send reply'}</button></div></form></div>`;
  const controls = staff ? `<div class="card"><h3>Move this return along</h3><form id="status-form" novalidate><div class="form-grid"><div><label class="field-label" for="st">Status</label><select class="field" id="st" name="status">${STATUSES.map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${esc(STATUS_LABEL[s])}</option>`).join('')}</select></div><div><label class="field-label" for="due">Due date</label><input class="field" id="due" name="dueOn" type="date" value="${esc(r.dueOn ?? '')}"></div></div><div class="form-row"><label class="field-label" for="note">Note for the client (optional)</label><input class="field" id="note" name="note" maxlength="500" placeholder="For example: Ready for your records"></div><div class="row-actions note"><button class="btn small" type="submit" ${d.busy ? 'disabled' : ''}>Update</button></div></form>
    <h3 class="gap-top">Return PDF</h3><p class="note">${r.returnFile ? `Attached: ${esc(r.returnFile.name)}. Choose a new file to replace it.` : 'Attach the finished return. It is shown to the client once the status is “Return prepared” or later.'}</p><div class="row-actions note"><label class="btn ghost small" for="return-file">${I.upload}${r.returnFile ? 'Replace PDF' : 'Attach PDF'}</label><input class="visually-hidden" id="return-file" type="file" accept="application/pdf,.pdf" tabindex="-1"></div></div>` : '';
  const dueLine = r.status === 'filed' || r.status === 'complete' ? '' : r.dueOn ? `<p class="note strong">${r.awaitingClient ? 'Waiting on the client · ' : ''}Due ${esc(dueText(r.dueOn))}</p>` : '';
  return back + `<div class="eyebrow">${staff ? 'VAT operations' : 'VAT compliance'}</div><div class="card detail-head"><div class="ret-top">${retHeader(r, staff)}${pill(r.status)}</div>${stepBar(r.status)}${dueLine}</div>
    ${d.notice ? `<div class="${d.notice.tone === 'error' ? 'error-box' : 'ok-box'}" role="status">${esc(d.notice.text)}</div>` : ''}
    <div class="detail-grid"><div class="stack">${talk}<div class="card"><h3>History</h3>${timeline(d.events, staff)}</div></div><div class="stack">${files}${controls}${staff ? uploadSummaryCard(d.uploadSummary) : ''}</div></div>`;
}

// ------------------------------------------------------------------ staff

export function staffQueue(s, f, now) {
  if (s.status === 'loading') return head('VAT operations', 'Submissions', '') + spinner();
  if (s.status === 'error') return head('VAT operations', 'Submissions', '') + errorBox(s.error);
  const all = s.returns;
  const count = (fn) => all.filter(fn).length;
  const stats = `<div class="stats">
    <div class="stat hero"><div class="stat-label">New, not yet received</div><div class="stat-num">${count((r) => r.status === 'submitted')}</div></div>
    <div class="stat"><div class="stat-label">In review or preparing</div><div class="stat-num">${count((r) => ['received', 'in_review', 'return_prepared'].includes(r.status))}</div></div>
    <div class="stat"><div class="stat-label">Waiting on a client reply</div><div class="stat-num">${count((r) => r.awaitingClient)}</div></div>
    <div class="stat"><div class="stat-label">Due in 14 days</div><div class="stat-num">${count((r) => isOpen(r) && r.dueOn && daysUntil(r.dueOn, now) <= 14)}</div></div></div>`;
  const opts = (items, current, all) => `<option value="">${all}</option>${items.map(([v, l]) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(l)}</option>`).join('')}`;
  const countries = [...new Map(all.map((r) => [r.country, r.countryName])).entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1));
  const clients = [...new Map(all.map((r) => [r.tenantId, r.tenantName])).entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1));
  const filters = `<div class="filters"><select class="sel" aria-label="Status" data-filter="status">${opts(STATUSES.map((x) => [x, STATUS_LABEL[x]]), f.status, 'All statuses')}</select><select class="sel" aria-label="Country" data-filter="country">${opts(countries, f.country, 'All countries')}</select><select class="sel" aria-label="Client" data-filter="client">${opts(clients, f.client, 'All clients')}</select></div>`;
  const rank = (r) => (isOpen(r) ? 0 : 1);
  const rows = all.filter((r) => (!f.status || r.status === f.status) && (!f.country || r.country === f.country) && (!f.client || r.tenantId === f.client)).sort((a, b) => rank(a) - rank(b) || String(a.dueOn ?? '9') .localeCompare(String(b.dueOn ?? '9')));
  const line = (r) => {
    const d = isOpen(r) && r.dueOn ? daysUntil(r.dueOn, now) : null;
    const due = !isOpen(r) ? (r.filedAt ? `Filed ${esc(fmtDate(r.filedAt.slice(0, 10), true))}` : '') : `<span class="${d !== null && d <= 7 ? 'due-soon' : 'strong'}">${esc(dueText(r.dueOn, now))}</span>`;
    const tags = [r.status === 'submitted' ? '<span class="attn">New file uploaded</span>' : '', r.awaitingClient ? '<span class="attn amber">Waiting on client reply</span>' : ''].join('');
    return `<button class="row" data-action="open-return" data-id="${esc(r.id)}"><div><div class="strong">${esc(r.tenantName)}</div>${tags}</div><div class="flagrow">${flag(r.country)}<span>${esc(r.countryName)} · ${esc(r.periodLabel)}</span></div><span class="tag">${esc(r.schemeLabel)}</span><span>${due}</span><span>${pill(r.status)}</span></button>`;
  };
  const table = rows.length
    ? `<div class="card flush"><div class="table-min"><div class="row head"><span>Client</span><span>Return</span><span>Scheme</span><span>Due</span><span>Status</span></div>${rows.map(line).join('')}</div></div>`
    : empty('No returns match', all.length ? 'Try clearing a filter.' : 'Returns will appear here as clients submit their sales files.');
  return head('VAT operations', 'Submissions', 'Every return across every client, in the order they need attention.') + stats + filters + table;
}

export function staffClients(s, ui) {
  if (s.status === 'loading') return head('VAT operations', 'Clients', '') + spinner();
  if (s.status === 'error') return head('VAT operations', 'Clients', '') + errorBox(s.error);
  const notice = ui.notice ? `<div class="${ui.notice.tone === 'error' ? 'error-box' : 'ok-box'}" role="status">${esc(ui.notice.text)}</div>` : '';
  const add = `<div class="card"><h3>Add a client</h3><form id="client-form" novalidate><div class="form-grid"><div><label class="field-label" for="cname">Client name</label><input class="field" id="cname" name="name" maxlength="120" required></div><div><label class="field-label" for="cemail">First person's email (optional)</label><input class="field" id="cemail" name="email" type="email" placeholder="name@client.com"></div></div><div class="row-actions note"><button class="btn small" type="submit" ${ui.busy ? 'disabled' : ''}>Add client</button></div></form></div>`;
  const schemeOpts = s.schemes.map((x) => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join('');
  const countryOpts = s.countries.map((x) => `<option value="${esc(x.code)}">${esc(x.name)}</option>`).join('');
  const card = (c) => `<section class="card"><div class="ret-top"><div class="ret-id"><div class="who-mark light">${esc(initials(c.name))}</div><div><div class="hd ret-title">${esc(c.name)}</div><div class="ret-meta"><span class="tag${c.registrations.length ? '' : ' muted'}">${c.registrations.length ? `${c.registrations.length} VAT filing${c.registrations.length === 1 ? '' : 's'}` : 'No VAT filings'}</span><span>${c.users} ${c.users === 1 ? 'person has' : 'people have'} access</span></div></div></div><div class="ret-right"><button class="btn ghost small" data-action="preview" data-tenant="${esc(c.id)}" data-name="${esc(c.name)}">View as client</button></div></div>
    <div class="gap-top">${c.registrations.length ? c.registrations.map((r) => `<div class="reg-row">${flag(r.country, true)}<span class="grow"><span class="strong">${esc(r.countryName)}</span> · ${esc(r.schemeLabel)} · ${esc(FREQ_LABEL[r.frequency])}${r.vatNumber ? ` · ${esc(r.vatNumber)}` : ''}</span><button class="btn danger small" data-action="unregister" data-id="${esc(r.id)}">Remove</button></div>`).join('') : '<p class="note">No filings set up yet.</p>'}</div>
    <form class="inline-form" data-form="register" data-tenant="${esc(c.id)}"><div><label class="field-label" for="s-${esc(c.id)}">Scheme</label><select class="field" id="s-${esc(c.id)}" name="scheme">${schemeOpts}</select></div><div><label class="field-label" for="c-${esc(c.id)}">Country</label><select class="field" id="c-${esc(c.id)}" name="country">${countryOpts}</select></div><div><label class="field-label" for="f-${esc(c.id)}">How often</label><select class="field" id="f-${esc(c.id)}" name="frequency"><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></div><div class="grow"><label class="field-label" for="v-${esc(c.id)}">VAT number (optional)</label><input class="field" id="v-${esc(c.id)}" name="vatNumber" maxlength="40"></div><button class="btn small" type="submit">Add filing</button></form>
    <form class="inline-form" data-form="access" data-tenant="${esc(c.id)}"><div class="grow"><label class="field-label" for="e-${esc(c.id)}">Give someone access</label><input class="field" id="e-${esc(c.id)}" name="email" type="email" placeholder="name@client.com" required></div><div><label class="field-label" for="r-${esc(c.id)}">Role</label><select class="field" id="r-${esc(c.id)}" name="role"><option value="owner">Owner</option><option value="member">Member</option><option value="accountant">Accountant (view only)</option></select></div><button class="btn ghost small" type="submit">Give access</button></form>
    <form class="inline-form" data-form="invite" data-tenant="${esc(c.id)}"><div class="grow"><label class="field-label" for="i-${esc(c.id)}">Resend welcome email</label><input class="field" id="i-${esc(c.id)}" name="email" type="email" placeholder="name@client.com" required></div><button class="btn ghost small" type="submit">Send</button></form></section>`;
  return head('VAT operations', 'Clients', 'Who we file for, in which countries, and who can sign in.') + `<div class="section-gap stack">${notice}${add}${[...s.clients].sort((x, y) => (y.registrations.length > 0) - (x.registrations.length > 0)).map(card).join('') || empty('No clients yet', 'Add your first client above.')}</div>`;
}

export function staffCountries(s, q) {
  if (s.status === 'loading' || q.status === 'loading') return head('VAT operations', 'Countries & schemes', '') + spinner();
  if (s.status === 'error') return head('VAT operations', 'Countries & schemes', '') + errorBox(s.error);
  const by = new Map();
  for (const c of s.clients) for (const r of c.registrations) {
    const e = by.get(r.country) ?? { code: r.country, name: r.countryName, clients: new Set(), schemes: new Set() };
    e.clients.add(c.id); e.schemes.add(`${r.schemeLabel} (${FREQ_LABEL[r.frequency].toLowerCase()})`); by.set(r.country, e);
  }
  const open = (code) => (q.returns ?? []).filter((r) => r.country === code && isOpen(r)).length;
  const rows = [...by.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  const body = rows.length
    ? `<div class="card flush"><div class="table-min"><div class="row head cols4"><span>Country</span><span>Schemes</span><span>Clients</span><span>Open returns</span></div>${rows.map((e) => `<div class="row cols4 static"><div class="flagrow">${flag(e.code)}<span class="strong">${esc(e.name)}</span></div><span>${[...e.schemes].map((x) => esc(x)).join(', ')}</span><span>${e.clients.size}</span><span>${open(e.code)}</span></div>`).join('')}</div></div>`
    : empty('No filings set up yet', 'Add filings to clients on the Clients page and they will be listed here.');
  return head('VAT operations', 'Countries & schemes', 'Where your clients are registered, and how much is open in each country.') + `<div class="section-gap">${body}</div>`;
}
