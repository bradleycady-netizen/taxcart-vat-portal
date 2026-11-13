/** Everything the VAT service knows about schemes, countries, statuses and periods. One place to tune. */

export const STATUSES = ['submitted', 'received', 'in_review', 'return_prepared', 'filed', 'complete'] as const;
export type VatStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<VatStatus, string> = {
  submitted: 'Submitted',
  received: 'Received',
  in_review: 'In review',
  return_prepared: 'Return prepared',
  filed: 'Filed',
  complete: 'Complete',
};

export const SCHEMES = ['uk_vat', 'ioss', 'oss', 'local_vat'] as const;
export type Scheme = (typeof SCHEMES)[number];
export type Frequency = 'monthly' | 'quarterly' | 'annual';

export const SCHEME_INFO: Record<Scheme, { label: string; frequencies: Frequency[]; euOnlyDestinations: boolean }> = {
  uk_vat: { label: 'UK VAT', frequencies: ['monthly', 'quarterly', 'annual'], euOnlyDestinations: false },
  ioss: { label: 'IOSS', frequencies: ['monthly'], euOnlyDestinations: true },
  oss: { label: 'OSS', frequencies: ['quarterly'], euOnlyDestinations: true },
  local_vat: { label: 'Local VAT', frequencies: ['monthly', 'quarterly', 'annual'], euOnlyDestinations: false },
};

/** Countries a client can be registered in. GB for UK VAT; the rest are EU member states. */
export const COUNTRIES: Record<string, string> = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus', CZ: 'Czechia', DK: 'Denmark', EE: 'Estonia',
  FI: 'Finland', FR: 'France', DE: 'Germany', GR: 'Greece', HU: 'Hungary', IE: 'Ireland', IT: 'Italy', LV: 'Latvia',
  LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta', NL: 'Netherlands', PL: 'Poland', PT: 'Portugal', RO: 'Romania',
  SK: 'Slovakia', SI: 'Slovenia', ES: 'Spain', SE: 'Sweden', GB: 'United Kingdom',
};
export const EU_CODES = new Set(Object.keys(COUNTRIES).filter((c) => c !== 'GB'));
// Greece is "GR" in ISO but "EL" on VAT numbers and some exports; both are accepted when reading files.
export const COUNTRY_ALIASES: Record<string, string> = { EL: 'GR', UK: 'GB' };

export function countryName(code: string): string {
  return COUNTRIES[code] ?? code;
}

/** Whether a scheme/country pairing makes sense. UK VAT is GB only; the EU schemes are EU member states only. */
export function validRegistration(scheme: Scheme, country: string, frequency: Frequency): string | null {
  if (!(country in COUNTRIES)) return 'Choose a country from the list.';
  if (scheme === 'uk_vat' && country !== 'GB') return 'UK VAT is for the United Kingdom.';
  if ((scheme === 'ioss' || scheme === 'oss') && country === 'GB') return 'IOSS and OSS are filed in an EU member state.';
  if (!SCHEME_INFO[scheme].frequencies.includes(frequency)) return `${SCHEME_INFO[scheme].label} returns are ${SCHEME_INFO[scheme].frequencies.join(' or ')}.`;
  return null;
}

// ------------------------------------------------------------------ periods

export interface Period {
  code: string; // 2026-10, 2026-Q3 or 2026
  label: string; // Oct 2026, Q3 2026 or 2026
  start: string; // YYYY-MM-DD
  end: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Turns a period code into its dates, or null if it is not a real period of that frequency. */
export function parsePeriod(code: string, frequency: Frequency): Period | null {
  let m: RegExpMatchArray | null;
  if (frequency === 'monthly' && (m = code.match(/^(\d{4})-(0[1-9]|1[0-2])$/))) {
    const y = Number(m[1]), mo = Number(m[2]);
    return { code, label: `${MONTHS[mo - 1]} ${y}`, start: iso(y, mo, 1), end: iso(y, mo, lastDay(y, mo)) };
  }
  if (frequency === 'quarterly' && (m = code.match(/^(\d{4})-Q([1-4])$/))) {
    const y = Number(m[1]), q = Number(m[2]);
    const sm = (q - 1) * 3 + 1, em = sm + 2;
    return { code, label: `Q${q} ${y}`, start: iso(y, sm, 1), end: iso(y, em, lastDay(y, em)) };
  }
  if (frequency === 'annual' && (m = code.match(/^(\d{4})$/))) {
    const y = Number(m[1]);
    return { code, label: String(y), start: iso(y, 1, 1), end: iso(y, 12, 31) };
  }
  return null;
}

function periodContaining(date: Date, frequency: Frequency): Period {
  const y = date.getUTCFullYear(), mo = date.getUTCMonth() + 1;
  const code = frequency === 'monthly' ? `${y}-${pad(mo)}` : frequency === 'quarterly' ? `${y}-Q${Math.ceil(mo / 3)}` : String(y);
  return parsePeriod(code, frequency)!;
}

function previousPeriod(p: Period, frequency: Frequency): Period {
  const d = new Date(`${p.start}T00:00:00Z`);
  d.setUTCDate(0); // the last day of the month before
  return periodContaining(d, frequency);
}

/** The most recent periods that have already ended, newest first (what a client can upload for now). */
export function recentEndedPeriods(now: Date, frequency: Frequency, count = 4): Period[] {
  const today = now.toISOString().slice(0, 10);
  let p = periodContaining(now, frequency);
  if (p.end >= today) p = previousPeriod(p, frequency);
  const out: Period[] = [];
  for (let i = 0; i < count; i++) {
    out.push(p);
    p = previousPeriod(p, frequency);
  }
  return out;
}

/**
 * Indicative due date, shown until Taxcart sets the real one on the return.
 *  UK VAT: one month and seven days after the period ends (standard online filing and payment).
 *  IOSS: the end of the month after the month.   OSS: the end of the month after the quarter.
 *  Local VAT: the end of the month after the period (varies by country, so staff adjust it).
 * These are defaults to be confirmed; staff can change the date on any return.
 */
export function defaultDueDate(scheme: Scheme, period: Period): string {
  const end = new Date(`${period.end}T00:00:00Z`);
  if (scheme === 'uk_vat') {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()));
    // clamp (30 Nov + 1 month must not become 30 Dec -> 2 Jan style overflow)
    if (d.getUTCMonth() !== (end.getUTCMonth() + 1) % 12) d.setUTCDate(0);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  const y = end.getUTCFullYear(), mo = end.getUTCMonth() + 2; // month after, 1-based
  const ny = mo > 12 ? y + 1 : y, nm = mo > 12 ? mo - 12 : mo;
  return iso(ny, nm, lastDay(ny, nm));
}

/** "2026-Q3" -> "Q3 2026", "2026-10" -> "Oct 2026", "2026" -> "2026". */
export function periodLabel(code: string): string {
  return (
    parsePeriod(code, 'monthly') ?? parsePeriod(code, 'quarterly') ?? parsePeriod(code, 'annual')
  )?.label ?? code;
}
