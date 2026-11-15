import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CanonicalFiling,
  CanonicalRegistration,
  ProviderConnection,
} from '../src/core/types.ts';
import { AlreadyRunningError, type RunOutcome, type SyncStore } from '../src/sync/sync.ts';

// ------------------------------------------------------------------ fake HTTP

export type Handler = (url: URL, init: RequestInit | undefined) => Response | Error | Promise<Response | Error>;

export interface RecordedCall {
  url: URL;
  init: RequestInit | undefined;
}

/** A scripted fetch: handlers are used in order, the last one repeating. */
export function fakeFetch(handlers: Handler | Handler[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const impl = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    calls.push({ url, init });
    const handler = Array.isArray(handlers) ? handlers[Math.min(i++, handlers.length - 1)]! : handlers;
    const out = await handler(url, init);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const noSleep = async (): Promise<void> => {};

// ------------------------------------------------------------------ connections

let seq = 0;
export function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  seq += 1;
  return {
    id: `conn-${seq}`,
    tenantId: 'tenant-a',
    product: 'us_sales_tax',
    providerKey: 'zamp',
    providerCompanyId: null,
    credentialRef: 'ZAMP_PARTNER_KEY',
    status: 'active',
    ...overrides,
  };
}

// ------------------------------------------------------------------ in-memory store

interface StoredConnectionState {
  lastSyncedAt: string | null;
  lastStatus: 'succeeded' | 'failed' | null;
  lastError: string | null;
}

export class InMemoryStore implements SyncStore {
  registrations = new Map<string, CanonicalRegistration & { connectionId: string; tenantId: string }>();
  filings = new Map<string, CanonicalFiling & { connectionId: string; tenantId: string }>();
  runs: { id: string; connectionId: string; outcome: RunOutcome | null }[] = [];
  state = new Map<string, StoredConnectionState>();

  async startRun(c: ProviderConnection): Promise<string> {
    // Mirrors the sync_runs_one_running index: one unfinished run per connection.
    if (this.runs.some((r) => r.connectionId === c.id && r.outcome === null)) throw new AlreadyRunningError(c.id);
    const id = `run-${this.runs.length + 1}`;
    this.runs.push({ id, connectionId: c.id, outcome: null });
    if (!this.state.has(c.id)) this.state.set(c.id, { lastSyncedAt: null, lastStatus: null, lastError: null });
    return id;
  }

  async upsertRegistrations(c: ProviderConnection, rows: CanonicalRegistration[]): Promise<number> {
    for (const r of rows) {
      this.registrations.set(`${c.id}|${r.jurisdiction}|${r.startedAt}`, { ...r, connectionId: c.id, tenantId: c.tenantId });
    }
    return rows.length;
  }

  async upsertFilings(c: ProviderConnection, rows: CanonicalFiling[]): Promise<number> {
    for (const f of rows) {
      this.filings.set(`${c.id}|${f.externalId}`, { ...f, connectionId: c.id, tenantId: c.tenantId });
    }
    return rows.length;
  }

  async finishRun(c: ProviderConnection, runId: string, outcome: RunOutcome): Promise<void> {
    const run = this.runs.find((r) => r.id === runId)!;
    run.outcome = outcome;
    const s = this.state.get(c.id)!;
    s.lastStatus = outcome.status;
    s.lastError = outcome.error;
    if (outcome.status === 'succeeded') s.lastSyncedAt = outcome.finishedAt;
  }

  filingsFor(connectionId: string): string[] {
    return [...this.filings.values()].filter((f) => f.connectionId === connectionId).map((f) => f.externalId).sort();
  }

  registrationsFor(connectionId: string): string[] {
    return [...this.registrations.values()].filter((r) => r.connectionId === connectionId).map((r) => r.jurisdiction).sort();
  }
}

// ------------------------------------------------------------------ canonical builders

export function canonFiling(overrides: Partial<CanonicalFiling> = {}): CanonicalFiling {
  return {
    externalId: 'DE:2026-Q2',
    jurisdiction: 'DE',
    periodCode: '2026-Q2',
    periodName: 'Q2 2026',
    frequency: 'quarterly',
    rawFrequencyCode: 'Q',
    dueOn: '2026-07-31',
    isCompleted: true,
    estimatedTaxDue: 100,
    returnConfirmation: 'VAT-1',
    paymentConfirmation: null,
    amountPaid: 100,
    documents: [{ kind: 'return' }],
    ...overrides,
  };
}

export function canonRegistration(overrides: Partial<CanonicalRegistration> = {}): CanonicalRegistration {
  return {
    jurisdiction: 'DE',
    taxId: 'DE123',
    startedAt: '2025-01-01',
    endedAt: null,
    frequency: 'quarterly',
    rawFrequencyCode: 'Q',
    ...overrides,
  };
}

// ------------------------------------------------------------------ fake Supabase client

interface Logged {
  table: string;
  op: 'insert' | 'upsert' | 'update';
  payload: unknown;
  onConflict?: string;
  filter?: [string, unknown];
}

/** Records what the store sends, in the shape of supabase-js's query builder. */
export function fakeSupabase(failTable?: string, failCode?: string) {
  const log: Logged[] = [];
  const err = (table: string) => (table === failTable ? { message: 'boom', ...(failCode ? { code: failCode } : {}) } : null);
  const db = {
    from(table: string) {
      return {
        insert(payload: unknown) {
          return {
            select: () => ({
              single: async () => {
                log.push({ table, op: 'insert', payload });
                return { data: { id: 'run-1' }, error: err(table) };
              },
            }),
          };
        },
        upsert: async (payload: unknown, opts: { onConflict: string }) => {
          log.push({ table, op: 'upsert', payload, onConflict: opts.onConflict });
          return { error: err(table) };
        },
        update(payload: unknown) {
          return {
            eq: async (col: string, val: unknown) => {
              log.push({ table, op: 'update', payload, filter: [col, val] });
              return { error: err(table) };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, log };
}
