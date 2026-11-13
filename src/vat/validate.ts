import { COUNTRY_ALIASES, EU_CODES, SCHEME_INFO, countryName, type Period, type Scheme } from './config.ts';
import { parseCsv } from './csv.ts';
import { readXlsx, XlsxError } from './xlsx.ts';

/**
 * Checks a client's sales file BEFORE it is sent to Taxcart, and again when it is submitted.
 * Works on CSV and .xlsx. Shopify's order export is the expected layout, but headings are matched loosely.
 *
 * "errors" stop the submission; "warnings" are shown and the client may still go ahead.
 */

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_DATA_ROWS = 50_000;
const SAMPLE = 5;

export interface Issue { code: string; message: string; rows?: number[] }
export interface CountryTotal { code: string; name: string; rows: number; amount: number }
export interface CheckResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  summary: null | {
    rows: number;
    totals: { currency: string; amount: number }[];
    byCountry: CountryTotal[];
    dateFrom: string | null;
    dateTo: string | null;
    columns: { date: string; country: string; amount: string; currency: string | null; order: string | null };
  };
  fileType: 'csv' | 'xlsx' | null;
}

// Heading synonyms, best first. Headings are compared with everything except letters and digits removed.
const SYNONYMS = {
  date: ['createdat', 'orderdate', 'date', 'paidat', 'processedat', 'invoicedate', 'transactiondate', 'created', 'vatreportingdate', 'paymentdate', 'shippingdate'],
  country: ['shippingcountrycode', 'shipcountrycode', 'destinationcountrycode', 'deliverycountrycode', 'countrycode', 'shippingcountry', 'shipcountry', 'destinationcountry', 'deliverycountry', 'shiptocountry', 'country', 'billingcountrycode', 'billingcountry', 'arrivalcountry', 'vatcountry'],
  amount: ['subtotal', 'netamount', 'netsales', 'net', 'salesamount', 'amount', 'ordertotal', 'total', 'value', 'lineitemprice', 'itemnetprice'],
  currency: ['currency', 'presentmentcurrency', 'currencycode', 'originalcurrency'],
  order: ['name', 'ordernumber', 'orderid', 'order', 'transactionid', 'invoicenumber', 'reference', 'id'],
} as const;
const EXPECTED = {
  date: 'Created at, Order date or Date',
  country: 'Shipping Country Code, Destination country or Country',
  amount: 'Subtotal, Net amount or Amount',
} as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Codes that exist in region lists but are not countries someone ships to.
const NOT_COUNTRIES = new Set(['EU', 'UN', 'EZ', 'QO', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'XA', 'XB', 'ZZ']);
let isoCodes: Set<string> | null = null;
let nameToCode: Map<string, string> | null = null;
function ensureCountryTables(): void {
  if (isoCodes) return;
  isoCodes = new Set();
  nameToCode = new Map();
  const dn = new Intl.DisplayNames(['en'], { type: 'region' });
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    let name: string | undefined;
    try { name = dn.of(code); } catch { continue; }
    if (!name || name === code || /^unknown/i.test(name) || NOT_COUNTRIES.has(code)) continue;
    isoCodes.add(code);
    nameToCode.set(norm(name), code);
  }
  for (const [n, c] of Object.entries({ usa: 'US', unitedstatesofamerica: 'US', uk: 'GB', greatbritain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', czechrepublic: 'CZ', holland: 'NL', turkey: 'TR', southkorea: 'KR', russia: 'RU' })) nameToCode.set(n, c);
}

/** "de", "DE", "Germany" -> "DE". Returns null if it is not a real country. */
export function normalizeCountry(raw: string): string | null {
  ensureCountryTables();
  const v = raw.trim();
  if (!v) return null;
  if (/^[A-Za-z]{2}$/.test(v)) {
    const up = v.toUpperCase();
    const code = COUNTRY_ALIASES[up] ?? up;
    return isoCodes!.has(code) ? code : null;
  }
  return nameToCode!.get(norm(v)) ?? null;
}

export function parseAmount(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[^\d.,-]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.includes('-') || s === '') return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    s = dec === '.' ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    s = /,\d{1,2}$/.test(s) && s.split(',').length === 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** Reads the date part of what was written. Slash dates are read day-first (UK, EU and Australian style) unless clearly month-first. */
export function parseDate(raw: string): string | null {
  const v = raw.trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?![\d])/);
  let y: number, mo: number, d: number;
  if (m) { y = +m[1]!; mo = +m[2]!; d = +m[3]!; }
  else if ((m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?![\d])/))) {
    const a = +m[1]!, b = +m[2]!;
    y = +m[3]!;
    if (a > 12 && b <= 12) { d = a; mo = b; } else if (b > 12 && a <= 12) { d = b; mo = a; } else { d = a; mo = b; }
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('windows-1252').decode(bytes); }
  if (text.includes('\u0000')) return null;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const fail = (message: string, code = 'unreadable'): CheckResult => ({ ok: false, errors: [{ code, message }], warnings: [], summary: null, fileType: null });

export function checkSalesFile(fileName: string, bytes: Uint8Array, ctx: { scheme: Scheme; period: Period }): CheckResult {
  if (bytes.length === 0) return fail('That file is empty.', 'empty');
  if (bytes.length > MAX_UPLOAD_BYTES) return fail('That file is larger than 4 MB. Please split it by month, or send it to your Taxcart contact.', 'too_large');
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const isOle = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (isOle || ext === 'xls') return fail('Old Excel (.xls) files are not supported. Please save the file as .xlsx or .csv and upload it again.', 'xls');
  if (ext !== 'csv' && ext !== 'xlsx') return fail('Please upload a .csv or .xlsx file.', 'file_type');

  let rows: string[][];
  let fileType: 'csv' | 'xlsx';
  if (ext === 'xlsx') {
    if (!isZip) return fail('That does not look like a real Excel (.xlsx) file. Please export it again.', 'file_type');
    try { rows = readXlsx(bytes); } catch (e) {
      return fail(e instanceof XlsxError && /too (large|many)/.test(e.message) ? 'That spreadsheet is too large to check. Please split it by month.' : 'We could not read that spreadsheet. Please export it again as .xlsx or .csv.');
    }
    fileType = 'xlsx';
  } else {
    if (isZip) return fail('That file is an Excel workbook with a .csv name. Please save it as a real CSV, or upload it as .xlsx.', 'file_type');
    const text = decodeText(bytes);
    if (text === null) return fail('That does not look like a CSV file. Please export it again.', 'file_type');
    rows = parseCsv(text);
    fileType = 'csv';
  }

  // Find the header row (normally the first row).
  let headerAt = -1;
  let cols: { date: number; country: number; amount: number; currency: number; order: number } | null = null;
  for (let i = 0; i < Math.min(rows.length, 6) && !cols; i++) {
    const heads = (rows[i] ?? []).map((h) => norm(h ?? ''));
    const find = (list: readonly string[]) => { for (const s of list) { const at = heads.indexOf(s); if (at >= 0) return at; } return -1; };
    const c = { date: find(SYNONYMS.date), country: find(SYNONYMS.country), amount: find(SYNONYMS.amount), currency: find(SYNONYMS.currency), order: find(SYNONYMS.order) };
    if (c.date >= 0 && c.country >= 0 && c.amount >= 0) { cols = c; headerAt = i; }
  }
  if (!cols) {
    const heads = (rows.find((r) => r.some((c) => c.trim() !== '')) ?? []).map((h) => h.trim()).filter(Boolean);
    const missing: string[] = [];
    const h0 = heads.map(norm);
    for (const k of ['date', 'country', 'amount'] as const) if (!SYNONYMS[k].some((s) => h0.includes(s))) missing.push(`${k === 'date' ? 'order date' : k === 'country' ? 'destination country' : 'sales amount'} (for example: ${EXPECTED[k]})`);
    const found = heads.slice(0, 12).join(', ');
    return { ok: false, fileType, summary: null, warnings: [], errors: [{ code: 'columns', message: `We could not find the ${missing.join(', the ')} column.${found ? ` The columns in your file are: ${found}${heads.length > 12 ? ', …' : ''}.` : ''} Please upload the standard order export.` }] };
  }

  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const headerRow = rows[headerAt]!;
  const colName = (i: number) => (headerRow[i] ?? '').trim();
  const data = rows.slice(headerAt + 1);
  if (data.length > MAX_DATA_ROWS) return fail('That file has more than 50,000 rows. Please split it by month.', 'too_many_rows');

  const blank: number[] = [], badDate: number[] = [], badCountry: number[] = [], badAmount: number[] = [], outside: number[] = [], nonEu: number[] = [], dupes: number[] = [];
  const countryRaw = new Map<string, number>();
  const byCountry = new Map<string, CountryTotal>();
  const totals = new Map<string, number>();
  const seen = new Set<string>();
  let used = 0, dateFrom: string | null = null, dateTo: string | null = null, negatives = 0, noCurrency = 0;
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');

  data.forEach((r, idx) => {
    const line = headerAt + idx + 2; // the row number as the person sees it in their spreadsheet
    const d = cell(r, cols!.date), c = cell(r, cols!.country), a = cell(r, cols!.amount);
    if (!d && !c && !a) return; // empty line, or a Shopify extra line item (only the order name is filled)
    used++;
    if (!d || !c || !a) { blank.push(line); return; }
    const date = parseDate(d), country = normalizeCountry(c), amount = parseAmount(a);
    let bad = false;
    if (!date) { badDate.push(line); bad = true; }
    if (!country) { badCountry.push(line); countryRaw.set(c, (countryRaw.get(c) ?? 0) + 1); bad = true; }
    if (amount === null) { badAmount.push(line); bad = true; }
    if (bad || !date || !country || amount === null) return;

    const orderId = cell(r, cols!.order);
    if (orderId) { const key = `${orderId}|${date}|${country}|${amount}`; if (seen.has(key)) dupes.push(line); seen.add(key); }
    if (date < ctx.period.start || date > ctx.period.end) outside.push(line);
    if (SCHEME_INFO[ctx.scheme].euOnlyDestinations && !EU_CODES.has(country)) nonEu.push(line);
    if (amount < 0) negatives++;
    const cur = (cell(r, cols!.currency) || '').toUpperCase();
    if (!cur) noCurrency++;
    const curKey = cur || '—';
    totals.set(curKey, (totals.get(curKey) ?? 0) + amount);
    const ct = byCountry.get(country) ?? { code: country, name: countryName(country), rows: 0, amount: 0 };
    ct.rows++; ct.amount += amount; byCountry.set(country, ct);
    if (!dateFrom || date < dateFrom) dateFrom = date;
    if (!dateTo || date > dateTo) dateTo = date;
  });

  const issue = (code: string, rows: number[], text: (n: number) => string): Issue => ({ code, message: text(rows.length), rows: rows.slice(0, SAMPLE) });
  if (used === 0) errors.push({ code: 'no_rows', message: 'We found the column headings but no sales rows underneath them.' });
  if (blank.length) errors.push(issue('blank', blank, (n) => `${n} row${n === 1 ? ' is' : 's are'} missing an order date, destination country or amount.`));
  if (badDate.length) errors.push(issue('bad_date', badDate, (n) => `${n} row${n === 1 ? ' has a date' : 's have dates'} we could not read. Use a format like 2026-10-31 or 31/10/2026.`));
  if (badCountry.length) {
    const names = [...countryRaw.keys()].slice(0, 4).map((s) => `“${s}”`).join(', ');
    errors.push(issue('bad_country', badCountry, (n) => `${n} row${n === 1 ? ' has a country' : 's have countries'} that ${n === 1 ? 'is' : 'are'} not valid (${names}). Use two-letter codes like DE or FR, or the full country name.`));
  }
  if (badAmount.length) errors.push(issue('bad_amount', badAmount, (n) => `${n} row${n === 1 ? ' has an amount' : 's have amounts'} we could not read as a number.`));

  if (outside.length) {
    const share = used ? outside.length / used : 0;
    const iss = issue('wrong_period', outside, (n) => `${n} row${n === 1 ? ' is' : 's are'} dated outside ${ctx.period.label} (${ctx.period.start} to ${ctx.period.end}). Check you chose the right period.`);
    (share > 0.05 ? errors : warnings).push(iss);
  }
  if (nonEu.length) warnings.push(issue('non_eu', nonEu, (n) => `${n} row${n === 1 ? ' ships' : 's ship'} outside the EU. ${SCHEME_INFO[ctx.scheme].label} covers EU destinations only, so Taxcart will ask about these.`));
  if (dupes.length) warnings.push(issue('duplicates', dupes, (n) => `${n} row${n === 1 ? ' looks' : 's look'} like an exact repeat of an earlier order. Check nothing is counted twice.`));
  if (cols.currency < 0) warnings.push({ code: 'no_currency', message: 'There is no currency column, so we cannot tell which currency the amounts are in.' });
  else if (noCurrency > 0) warnings.push({ code: 'blank_currency', message: `${noCurrency} row${noCurrency === 1 ? ' has' : 's have'} no currency.` });
  if (totals.size > 1 && cols.currency >= 0) warnings.push({ code: 'mixed_currency', message: `The file mixes ${[...totals.keys()].join(', ')}. Totals are shown for each currency separately.` });
  if (negatives > 0) warnings.push({ code: 'negatives', message: `${negatives} row${negatives === 1 ? ' is' : 's are'} negative (refunds or returns). They are included in the totals.` });

  const result: CheckResult = {
    ok: errors.length === 0,
    errors,
    warnings,
    fileType,
    summary: {
      rows: used - blank.length - badDate.length - badCountry.length - badAmount.length,
      totals: [...totals].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })),
      byCountry: [...byCountry.values()].map((c) => ({ ...c, amount: Math.round(c.amount * 100) / 100 })).sort((x, y) => y.amount - x.amount).slice(0, 30),
      dateFrom, dateTo,
      columns: { date: colName(cols.date), country: colName(cols.country), amount: colName(cols.amount), currency: cols.currency >= 0 ? colName(cols.currency) : null, order: cols.order >= 0 ? colName(cols.order) : null },
    },
  };
  return result;
}
