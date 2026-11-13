// Plain helpers for the VAT pages: text escaping, dates, statuses. No browser globals are touched at import time.

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const STATUSES = ['submitted', 'received', 'in_review', 'return_prepared', 'filed', 'complete'];
export const STATUS_LABEL = { submitted: 'Submitted', received: 'Received', in_review: 'In review', return_prepared: 'Return prepared', filed: 'Filed', complete: 'Complete' };
export const STEP_LABEL = { submitted: 'Submitted', received: 'Received', in_review: 'In review', return_prepared: 'Prepared', filed: 'Filed', complete: 'Complete' };
export const STATUS_CLASS = { submitted: 's-new', received: 's-prog', in_review: 's-prog', return_prepared: 's-prog', filed: 's-done', complete: 's-final' };
export const FREQ_LABEL = { monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-30" -> "30 Nov 2026" (or "30 Nov" when short). Dates are shown as written, never shifted by time zone. */
export function fmtDate(iso, short = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${short ? '' : ` ${m[1]}`}`;
}
export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Whole days from today until a YYYY-MM-DD date (negative = overdue). */
export function daysUntil(iso, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return null;
  const a = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86_400_000);
}
export function dueText(iso, now = new Date()) {
  const d = daysUntil(iso, now);
  if (d === null) return '';
  const when = fmtDate(iso, true);
  if (d < 0) return `${when} · ${-d} day${d === -1 ? '' : 's'} overdue`;
  if (d === 0) return `${when} · today`;
  return `${when} · ${d} day${d === 1 ? '' : 's'}`;
}

export function money(amount, currency) {
  const n = Number(amount);
  const text = n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency && currency !== '—' ? `${text} ${currency}` : text;
}
export function fileSize(bytes) {
  const n = Number(bytes) || 0;
  return n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`;
}
export const isOpen = (r) => r.status !== 'filed' && r.status !== 'complete';
