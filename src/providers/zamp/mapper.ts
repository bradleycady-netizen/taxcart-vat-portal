import type {
  CanonicalFiling,
  CanonicalRegistration,
  DocumentKind,
  FilingFrequency,
} from '../../core/types.ts';
import { Shape } from '../../core/shape.ts';

/**
 * Parsing (untrusted JSON -> typed Zamp objects) and mapping (Zamp objects -> canonical model).
 * Field names follow Zamp's public docs: https://developer.zamp.com/api-reference/filings.md and
 * /registrations.md. Re-verify against real responses once a key is available.
 */

const shape = new Shape('zamp');

// ------------------------------------------------------------------ raw Zamp shapes

export interface ZampFile {
  type: string;
  signedUrl: string;
}

export interface ZampArtifact {
  returnConfirmation: string | null;
  paymentConfirmation: string | null;
  amountPaid: number | null;
  files: ZampFile[];
}

export interface ZampFiling {
  state: string;
  periodCode: string;
  periodName: string;
  frequencyCode: string | null;
  dueOn: string;
  isCompleted: boolean;
  estimatedTaxDue: number | null;
  artifacts: ZampArtifact[];
}

export interface ZampRegistration {
  state: string;
  taxId: string | null;
  startedAt: string;
  endedAt: string | null;
  frequencies: { code: string; startedAt: string; endedAt: string | null }[];
}

// ------------------------------------------------------------------ parsing

export function parseRegistrations(body: unknown): ZampRegistration[] {
  return shape.array(body, 'registrations').map((item, i) => {
    const where = `registrations[${i}]`;
    const o = shape.record(item, where);
    const reg = shape.record(o['registration'], `${where}.registration`);
    const freqs = o['frequencies'] === undefined || o['frequencies'] === null
      ? []
      : shape.array(o['frequencies'], `${where}.frequencies`);
    return {
      state: shape.string(o, 'state', where),
      taxId: shape.optString(reg, 'taxId', `${where}.registration`),
      startedAt: shape.date(reg, 'startedAt', `${where}.registration`),
      endedAt: shape.optDate(reg, 'endedAt', `${where}.registration`),
      frequencies: freqs.map((f, j) => {
        const fw = `${where}.frequencies[${j}]`;
        const fo = shape.record(f, fw);
        return {
          code: shape.string(fo, 'code', fw),
          startedAt: shape.date(fo, 'startedAt', fw),
          endedAt: shape.optDate(fo, 'endedAt', fw),
        };
      }),
    };
  });
}

export interface ParsedFilingsPage {
  filings: ZampFiling[];
  nextCursor: string | null;
}

export function parseFilingsPage(body: unknown): ParsedFilingsPage {
  const root = shape.record(body, 'filings response');
  const data = shape.array(root['data'], 'filings.data');
  const nextCursor = shape.optString(root, 'nextCursor', 'filings');
  const filings = data.map((item, i): ZampFiling => {
    const where = `filings.data[${i}]`;
    const o = shape.record(item, where);
    const period = shape.record(o['period'], `${where}.period`);
    const freq = o['frequency'] === undefined || o['frequency'] === null
      ? null
      : shape.record(o['frequency'], `${where}.frequency`);
    const artifacts = o['artifacts'] === undefined || o['artifacts'] === null
      ? []
      : shape.array(o['artifacts'], `${where}.artifacts`);
    return {
      state: shape.string(o, 'state', where),
      periodCode: shape.string(period, 'code', `${where}.period`),
      periodName: shape.string(period, 'name', `${where}.period`),
      frequencyCode: freq ? shape.optString(freq, 'code', `${where}.frequency`) : null,
      dueOn: shape.date(o, 'dueOn', where),
      isCompleted: shape.boolean(o, 'isCompleted', where),
      estimatedTaxDue: shape.optNumber(o, 'estimatedTaxDue', where),
      artifacts: artifacts.map((a, j): ZampArtifact => {
        const aw = `${where}.artifacts[${j}]`;
        const ao = shape.record(a, aw);
        const files = ao['files'] === undefined || ao['files'] === null
          ? []
          : shape.array(ao['files'], `${aw}.files`);
        return {
          returnConfirmation: shape.optString(ao, 'returnConfirmation', aw),
          paymentConfirmation: shape.optString(ao, 'paymentConfirmation', aw),
          amountPaid: shape.optNumber(ao, 'amountPaid', aw),
          files: files.map((f, k) => {
            const fw = `${aw}.files[${k}]`;
            const fo = shape.record(f, fw);
            return { type: shape.string(fo, 'type', fw), signedUrl: shape.string(fo, 'signedUrl', fw) };
          }),
        };
      }),
    };
  });
  return { filings, nextCursor };
}

// ------------------------------------------------------------------ mapping

/**
 * Only the unambiguous codes are translated. Zamp also documents MDFA, MP, NYA, NYQ, NYQP and QP
 * without defining them, so those become 'other' and the raw code is kept alongside.
 * Ask Zamp to define them, then extend this table.
 */
const FREQUENCY_BY_CODE: Record<string, FilingFrequency> = {
  M: 'monthly',
  Q: 'quarterly',
  SA: 'semi_annual',
  A: 'annual',
};

export function mapFrequency(code: string | null): FilingFrequency | null {
  if (code === null) return null;
  return FREQUENCY_BY_CODE[code] ?? 'other';
}

const DOCUMENT_KIND_BY_TYPE: Record<string, DocumentKind> = {
  FILING_RETURN: 'return',
  FILING_PAYMENT: 'payment',
  FILING_RETURN_PAYMENT: 'return_and_payment',
  FILING_TEMPLATE: 'template',
  FILING_OTHER: 'other',
};

export function mapDocumentKind(type: string): DocumentKind {
  return DOCUMENT_KIND_BY_TYPE[type] ?? 'other';
}

/** Choose the registration's current frequency: the open-ended one, else the most recent. */
function currentFrequencyCode(reg: ZampRegistration): string | null {
  if (reg.frequencies.length === 0) return null;
  const sorted = [...reg.frequencies].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return (sorted.find((f) => f.endedAt === null) ?? sorted[0])!.code;
}

export function mapRegistration(reg: ZampRegistration): CanonicalRegistration {
  const raw = currentFrequencyCode(reg);
  return {
    jurisdiction: reg.state,
    taxId: reg.taxId,
    startedAt: reg.startedAt,
    endedAt: reg.endedAt,
    frequency: mapFrequency(raw),
    rawFrequencyCode: raw,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function mapFiling(f: ZampFiling): CanonicalFiling {
  const withReturn = f.artifacts.find((a) => a.returnConfirmation !== null);
  const withPayment = f.artifacts.find((a) => a.paymentConfirmation !== null);
  const paid = f.artifacts.map((a) => a.amountPaid).filter((n): n is number => n !== null);
  return {
    externalId: `${f.state}:${f.periodCode}`,
    jurisdiction: f.state,
    periodCode: f.periodCode,
    periodName: f.periodName,
    frequency: mapFrequency(f.frequencyCode),
    rawFrequencyCode: f.frequencyCode,
    dueOn: f.dueOn,
    isCompleted: f.isCompleted,
    estimatedTaxDue: f.estimatedTaxDue,
    returnConfirmation: withReturn?.returnConfirmation ?? null,
    paymentConfirmation: withPayment?.paymentConfirmation ?? null,
    amountPaid: paid.length > 0 ? round2(paid.reduce((s, n) => s + n, 0)) : null,
    documents: f.artifacts.flatMap((a) => a.files.map((file) => ({ kind: mapDocumentKind(file.type) }))),
  };
}
