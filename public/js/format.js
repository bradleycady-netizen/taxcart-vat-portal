import { ICONS } from './icons.js';

// Pure helpers and HTML builders. Everything that reaches innerHTML passes through esc().

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const PRODUCTS = {
  us_sales_tax: { label: 'US Sales Tax', desc: 'Filings and registrations', tag: 'US Sales Tax', cls: 'us', currency: 'USD' },
  eu_vat: { label: 'VAT', desc: 'Returns and registrations', tag: 'VAT', cls: 'vat', currency: null },
};

const FREQ = { monthly: 'Monthly', quarterly: 'Quarterly', semi_annual: 'Semi-annual', annual: 'Annual' };

export function frequencyLabel(freq, rawCode) {
  if (freq && FREQ[freq]) return FREQ[freq];
  return rawCode ? `Other (${rawCode})` : '—';
}

/** "2026-04-20" -> "20 Apr 2026". Invalid or missing -> "—". Parsed as a calendar date, never shifted by time zone. */
export function formatDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!m) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mi = Number(m[2]) - 1;
  if (mi < 0 || mi > 11) return '—';
  return `${Number(m[3])} ${months[mi]} ${m[1]}`;
}

export function formatDateTime(value, locale = 'en-AU', timeZone = undefined) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone }).format(d);
}

/** Money for a product. VAT has no stated currency yet, so it shows a plain amount rather than guess a symbol. */
export function formatMoney(value, product) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const currency = PRODUCTS[product]?.currency;
  const opts = currency ? { style: 'currency', currency } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return new Intl.NumberFormat('en-US', opts).format(n);
}

export const KIND_LABEL = { return: 'Return', payment: 'Payment confirmation', return_and_payment: 'Return & payment', template: 'Template', other: 'Document' };

export function syncNote(sync) {
  if (!sync) return { tone: 'ok', text: '' };
  if (sync.status === 'pending') return { tone: 'pending', text: 'Your data is being set up. It will appear here shortly.' };
  const when = formatDateTime(sync.asOf);
  if (sync.status === 'stale') return { tone: 'stale', text: `Showing data as of ${when}. We could not refresh it just now, so it may be out of date.` };
  return { tone: 'ok', text: `Up to date as of ${when}` };
}

export function filingStatus(f, today = new Date().toISOString().slice(0, 10)) {
  if (f.isCompleted) return { key: 'complete', label: 'Filed' };
  if (typeof f.dueOn === 'string' && f.dueOn < today) return { key: 'overdue', label: 'Past due date' };
  return { key: 'upcoming', label: 'Upcoming' };
}

export function summarize(filings, today) {
  const s = { complete: 0, upcoming: 0, overdue: 0, next: null };
  for (const f of filings) {
    const st = filingStatus(f, today).key;
    s[st] += 1;
    if (st !== 'complete' && typeof f.dueOn === 'string' && (!s.next || f.dueOn < s.next.dueOn)) s.next = f;
  }
  return s;
}

export function syncBanner(sync) {
  const n = syncNote(sync);
  if (!n.text) return '';
  return `<div class="sync-note ${n.tone}" role="status">${esc(n.text)}</div>`;
}

export function emptyState(text) {
  return `<div class="empty-state">${esc(text)}</div>`;
}

export function errorState(message) {
  return `<div class="error-state" role="alert"><p>${esc(message)}</p><button class="btn-inline" data-action="retry">Try again</button></div>`;
}

function docLinks(f) {
  if (!f.documents?.length) return '<span class="muted">—</span>';
  return f.documents
    // hrefs come from our own server, but only same-site paths are ever rendered as links
    .filter((d) => typeof d.href === 'string' && d.href.startsWith('/api/documents?'))
    .map((d) => `<a class="dl-link" href="${esc(d.href)}" download>${esc(KIND_LABEL[d.kind] ?? 'Document')}</a>`)
    .join('<br>');
}

export function filingsTable(filings, product, today) {
  if (!filings.length) return emptyState('No filings to show yet.');
  const rows = filings
    .map((f) => {
      const st = filingStatus(f, today);
      return `<tr>
        <td data-label="Jurisdiction"><strong>${esc(f.jurisdiction)}</strong></td>
        <td data-label="Period">${esc(f.periodName || f.periodCode)}</td>
        <td data-label="Frequency">${esc(frequencyLabel(f.frequency))}</td>
        <td data-label="Due" class="num">${esc(formatDate(f.dueOn))}</td>
        <td data-label="Status"><span class="status-chip ${st.key}">${esc(st.label)}</span></td>
        <td data-label="Estimated tax" class="num right">${esc(formatMoney(f.estimatedTaxDue, product))}</td>
        <td data-label="Paid" class="num right">${esc(formatMoney(f.amountPaid, product))}</td>
        <td data-label="Documents">${docLinks(f)}</td>
      </tr>`;
    })
    .join('');
  return `<div class="card table-card"><table class="data">
    <thead><tr><th>Jurisdiction</th><th>Period</th><th>Frequency</th><th>Due</th><th>Status</th><th class="right">Estimated tax</th><th class="right">Paid</th><th>Documents</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

export function registrationsTable(regs) {
  if (!regs.length) return emptyState('No registrations to show yet.');
  const rows = regs
    .map((r) => {
      const ended = Boolean(r.endedAt);
      return `<tr>
        <td data-label="Jurisdiction"><strong>${esc(r.jurisdiction)}</strong></td>
        <td data-label="Registration number" class="num">${esc(r.taxId || '—')}</td>
        <td data-label="Registered since" class="num">${esc(formatDate(r.startedAt))}</td>
        <td data-label="Frequency">${esc(frequencyLabel(r.frequency, r.frequencyCode))}</td>
        <td data-label="Status"><span class="status-chip ${ended ? 'ended' : 'complete'}">${ended ? `Ended ${esc(formatDate(r.endedAt))}` : 'Active'}</span></td>
      </tr>`;
    })
    .join('');
  return `<div class="card table-card"><table class="data">
    <thead><tr><th>Jurisdiction</th><th>Registration number</th><th>Registered since</th><th>Frequency</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** Unfiled returns due in the next `days` days, with the total of their estimates (filings with no estimate add nothing). */
export function liabilitySummary(filings, today = todayIso(), days = 30) {
  const end = addDays(today, days);
  const due = filings.filter((f) => !f.isCompleted && typeof f.dueOn === 'string' && f.dueOn >= today && f.dueOn <= end);
  const total = due.reduce((sum, f) => sum + (Number.isFinite(Number(f.estimatedTaxDue)) ? Number(f.estimatedTaxDue) : 0), 0);
  return { total, count: due.length };
}

/** Things that need a look: overdue unfiled returns first, then returns due within 14 days. Never invented. */
export function actionItems(filings, today = todayIso()) {
  const soon = addDays(today, 14);
  const label = (f) => `<strong>${esc(f.jurisdiction)}</strong> ${esc(f.periodName || f.periodCode)}`;
  const overdue = filings.filter((f) => filingStatus(f, today).key === 'overdue').sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1));
  const dueSoon = filings.filter((f) => filingStatus(f, today).key === 'upcoming' && f.dueOn <= soon).sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1));
  return [
    ...overdue.map((f) => ({ tone: 'warn', html: `${label(f)} is past its due date and is not yet marked as filed.` })),
    ...dueSoon.map((f) => ({ tone: 'soon', html: `${label(f)} is due on ${esc(formatDate(f.dueOn))}.` })),
  ].slice(0, 6);
}

function cardHead(icon, title, sub, link) {
  return `<div class="card-head"><div class="card-head-left"><div class="card-icon">${icon}</div><div><div class="card-title">${esc(title)}</div>${sub ? `<div class="card-sub">${esc(sub)}</div>` : ''}</div></div>${link ? `<button class="card-link" data-action="nav" data-view="${esc(link)}">View all</button>` : ''}</div>`;
}

/** Nexus tracking has no data source yet. Say so plainly rather than show invented numbers. */
export function nexusCard() {
  return `<div class="card">${cardHead(ICONS.flag, 'Economic nexus', "States where you're approaching or past a filing threshold", 'nexus')}
    <div class="card-body-note">Your tax team is monitoring where you may need to register. Progress details will appear here once they are available in the portal. Contact us any time for an update.</div></div>`;
}

export function nexusPage() {
  return `<div class="card placeholder"><div class="card-title">Nexus tracking</div>
    <p>Economic nexus is the point at which your sales into a state require you to register there. Your tax team monitors this for you.</p>
    <p>Threshold progress for each state will appear on this page once it is available in the portal. Until then, contact us any time for an update.</p></div>`;
}

export function overview(filings, registrations, product, today = todayIso()) {
  const s = summarize(filings, today);
  const liab = liabilitySummary(filings, today);
  const money = formatMoney(liab.total, product);
  const cur = PRODUCTS[product]?.currency === 'USD' ? '<span class="cur">$</span>' : '';
  const bare = cur ? money.replace(/^\$/, '') : money;
  const sub = liab.count ? `Across ${liab.count} filing${liab.count === 1 ? '' : 's'} due in the next 30 days` : 'Nothing due in the next 30 days';
  const chip = (n, label) => `<div class="hero-chip"><div class="hero-chip-num num">${esc(n)}</div><div class="hero-chip-label">${esc(label)}</div></div>`;

  const actions = actionItems(filings, today);
  const actionRows = actions.length
    ? actions.map((a) => `<div class="action-row"><div class="action-dot ${a.tone}"></div><div class="action-text">${a.html}</div></div>`).join('')
    : '<div class="action-empty">Nothing needs your attention right now.</div>';

  const active = registrations.filter((r) => !r.endedAt);
  const regRows = active.length
    ? active.slice(0, 3).map((r) => `<div class="reg-row"><span class="reg-state">${esc(r.jurisdiction)}</span><span class="reg-date num">since ${esc(formatDate(r.startedAt))}</span></div>`).join('')
    : '<div class="action-empty">No registrations yet.</div>';

  const total = filings.length;
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  const open = filings.filter((f) => !f.isCompleted).sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1)).slice(0, 4);
  const trackerRows = open.length
    ? open.map((f) => {
        const st = filingStatus(f, today);
        return `<tr><td><span class="nexus-state">${esc(f.jurisdiction)}</span></td><td>${esc(f.periodName || f.periodCode)}</td><td><span class="status-chip ${st.key}">${st.key === 'overdue' ? 'Past due date' : `Due ${esc(formatDate(f.dueOn))}`}</span></td><td class="num">${esc(formatMoney(f.estimatedTaxDue, product))}</td></tr>`;
      }).join('')
    : `<tr><td colspan="4" class="empty-row">No upcoming filings. You're all caught up.</td></tr>`;
  const tracker = `<div class="card">${cardHead(ICONS.folder, 'Filing tracker', 'Progress across your tracked filings', 'filings')}
    <div class="filing-progress"><div class="fp-track">
      <div class="fp-seg complete" data-w="${pct(s.complete)}"></div><div class="fp-seg progress" data-w="${pct(s.upcoming)}"></div><div class="fp-seg overdue" data-w="${pct(s.overdue)}"></div></div>
      <div class="fp-legend"><span><span class="fp-dot complete"></span>${s.complete} complete</span><span><span class="fp-dot progress"></span>${s.upcoming} upcoming</span>${s.overdue ? `<span><span class="fp-dot overdue"></span>${s.overdue} past due date</span>` : ''}</div></div>
    <table class="data"><thead><tr><th>Jurisdiction</th><th>Period</th><th>Status</th><th>Estimate</th></tr></thead><tbody>${trackerRows}</tbody></table></div>`;

  const left = product === 'us_sales_tax' ? nexusCard() : tracker;
  return `<div class="hero-stat">
      <div class="hero-stat-left"><div class="hero-stat-label">Estimated tax, upcoming filings</div>
        <div class="hero-stat-num num">${cur}${esc(bare)}</div><div class="hero-stat-sub">${esc(sub)}</div></div>
      <div class="hero-stat-chips">${chip(s.complete, 'Filings completed')}${chip(s.upcoming, 'Upcoming')}${chip(s.overdue, 'Past due date')}</div>
    </div>
    <div class="grid-2">
      ${left}
      <div>
        <div class="card list-card">${cardHead(ICONS.shield, 'Action needed')}${actionRows}</div>
        <div class="card">${cardHead(ICONS.registrations, 'Registrations', '', 'registrations')}${regRows}</div>
      </div>
    </div>
    ${product === 'us_sales_tax' ? tracker : ''}`;
}

export function pager(page) {
  if (!page || (!page.hasMore && page.offset === 0)) return '';
  return `<div class="pager">
    <button class="btn-inline" data-action="page-prev" ${page.offset === 0 ? 'disabled' : ''}>Previous</button>
    <span class="muted">Showing ${page.offset + 1}+</span>
    <button class="btn-inline" data-action="page-next" ${page.hasMore ? '' : 'disabled'}>Next</button>
  </div>`;
}
