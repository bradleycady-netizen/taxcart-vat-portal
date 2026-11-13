import { ProviderError } from '../core/errors.ts';
import { ZampAdapter } from '../providers/zamp/adapter.ts';
import { ZampClient } from '../providers/zamp/client.ts';

export interface SmokeOptions {
  apiKey: string;
  baseUrl?: string;
  /** Partner use only: act on behalf of this Zamp company. */
  companyId?: string | null;
  fetchImpl?: typeof fetch;
}

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeReport {
  steps: SmokeStep[];
  /** Field names and types only, never values, so it is safe to paste into a chat or ticket. */
  shapes: Record<string, unknown>;
  ok: boolean;
}

/** Reduce a JSON value to its structure: keys and types, no data. */
export function describeShape(v: unknown): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? [] : [describeShape(v[0])];
  if (typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, describeShape(val)]));
  }
  return typeof v;
}

/**
 * Exercises the adapter against a live Zamp key and reports what worked.
 * Read-only: it never creates or changes anything at Zamp.
 */
export async function runSmoke(opts: SmokeOptions): Promise<SmokeReport> {
  const steps: SmokeStep[] = [];
  const shapes: Record<string, unknown> = {};
  const ctx = { providerCompanyId: opts.companyId ?? null };
  const common = {
    apiKey: opts.apiKey,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };
  const adapter = new ZampAdapter(common);
  const raw = new ZampClient(common);

  async function step<T>(name: string, fn: () => Promise<{ detail: string; value?: T }>): Promise<T | undefined> {
    try {
      const { detail, value } = await fn();
      steps.push({ name, ok: true, detail });
      return value;
    } catch (e) {
      const detail = e instanceof ProviderError ? `${e.kind}: ${e.message}` : 'unexpected error';
      steps.push({ name, ok: false, detail });
      return undefined;
    }
  }

  await step('Authenticate (GET /companies)', async () => {
    await adapter.healthCheck(ctx);
    return { detail: 'credential accepted' };
  });

  const regs = await step('Registrations (GET /registrations)', async () => {
    const value = await adapter.listRegistrations(ctx);
    const states = value.map((r) => r.jurisdiction).sort();
    return { detail: `${value.length} registration(s): ${states.slice(0, 12).join(', ')}${states.length > 12 ? ', ...' : ''}`, value };
  });

  const filings = await step('Filings (GET /filings, all pages)', async () => {
    const value = await adapter.listFilings(ctx);
    const done = value.filter((f) => f.isCompleted).length;
    return { detail: `${value.length} filing(s), ${done} completed`, value };
  });

  await step('Document link (re-queries the filing, mints a fresh link)', async () => {
    const f = (filings ?? []).find((x) => x.isCompleted && x.documents.length > 0);
    if (!f) return { detail: 'skipped: no completed filing with documents to test (expected on a trial key)' };
    await adapter.getDocumentLink(ctx, {
      jurisdiction: f.jurisdiction,
      periodCode: f.periodCode,
      dueOn: f.dueOn,
      kind: f.documents[0]!.kind,
    });
    return { detail: `link minted for ${f.jurisdiction} ${f.periodCode}` };
  });

  // Structure-only dumps, for comparing against the docs.
  const q = ctx.providerCompanyId ? { companyId: ctx.providerCompanyId } : {};
  try {
    const r = await raw.get('/registrations', q);
    shapes['GET /registrations (first item)'] = describeShape(Array.isArray(r) ? r[0] : r);
    const f = (await raw.get('/filings', q)) as { data?: unknown[] };
    shapes['GET /filings (envelope, first item)'] = describeShape({ ...f, data: f.data ? f.data.slice(0, 1) : f.data });
  } catch {
    /* the steps above already reported the failure */
  }

  void regs;
  return { steps, shapes, ok: steps.every((s) => s.ok) };
}
