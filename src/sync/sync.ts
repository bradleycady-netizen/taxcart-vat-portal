import { ProviderError } from '../core/errors.ts';
import type {
  CanonicalFiling,
  CanonicalRegistration,
  ProviderAdapter,
  ProviderConnection,
} from '../core/types.ts';

/**
 * Thrown by SyncStore.startRun when another sync for the same connection is still running
 * (enforced by the unique index in migration 0002). Not a failure: the caller just skips.
 */
export class AlreadyRunningError extends Error {
  constructor(connectionId: string) {
    super(`A sync is already running for connection ${connectionId}`);
    this.name = 'AlreadyRunningError';
  }
}

/** Where synced data lands. Implemented for Supabase (supabaseStore.ts) and in memory for tests. */
export interface SyncStore {
  /** Record that a sync started; returns the run id. */
  startRun(connection: ProviderConnection): Promise<string>;
  /** Insert-or-update by natural key. MUST NOT delete anything: filing history is kept permanently. */
  upsertRegistrations(connection: ProviderConnection, rows: CanonicalRegistration[], syncedAt: string): Promise<number>;
  upsertFilings(connection: ProviderConnection, rows: CanonicalFiling[], syncedAt: string): Promise<number>;
  /**
   * Close the run and update the connection's status fields.
   * `last_synced_at` must advance ONLY on success, so the dashboard's "as of" time stays honest.
   */
  finishRun(connection: ProviderConnection, runId: string, outcome: RunOutcome): Promise<void>;
}

export interface RunOutcome {
  status: 'succeeded' | 'failed';
  registrations: number;
  filings: number;
  error: string | null;
  finishedAt: string;
}

export interface SyncResult {
  connectionId: string;
  /**
   * skipped  = nothing to do (paused, or another sync already running)
   * deferred = not attempted because the run's time budget ran out; it goes first next time
   */
  status: 'succeeded' | 'failed' | 'skipped' | 'deferred';
  registrations: number;
  filings: number;
  error: string | null;
}

export interface SyncOptions {
  now?: () => Date;
}

/**
 * Sync one connection.
 *
 * Fetch-then-write: everything is pulled from the provider first. If any fetch fails we write
 * nothing, so the cached copy stays exactly as it was last time (this is the continuity
 * guarantee: an outage at the provider never damages what clients can already see).
 * Upserts are idempotent, so a crash between the two writes is repaired by the next run.
 *
 * Never throws for provider problems; returns a failed SyncResult instead.
 */
export async function syncConnection(
  connection: ProviderConnection,
  adapter: ProviderAdapter,
  store: SyncStore,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const now = opts.now ?? (() => new Date());
  if (connection.status !== 'active') {
    return { connectionId: connection.id, status: 'skipped', registrations: 0, filings: 0, error: null };
  }

  let runId: string;
  try {
    runId = await store.startRun(connection);
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      return { connectionId: connection.id, status: 'skipped', registrations: 0, filings: 0, error: 'already running' };
    }
    throw err;
  }
  const ctx = { providerCompanyId: connection.providerCompanyId };

  let registrations = 0;
  let filings = 0;
  try {
    const regs = adapter.capabilities.registrations ? await adapter.listRegistrations(ctx) : [];
    const fils = adapter.capabilities.filings ? await adapter.listFilings(ctx) : [];

    const syncedAt = now().toISOString();
    registrations = await store.upsertRegistrations(connection, regs, syncedAt);
    filings = await store.upsertFilings(connection, fils, syncedAt);

    await store.finishRun(connection, runId, {
      status: 'succeeded',
      registrations,
      filings,
      error: null,
      finishedAt: now().toISOString(),
    });
    return { connectionId: connection.id, status: 'succeeded', registrations, filings, error: null };
  } catch (err) {
    const message = describeError(err);
    await store.finishRun(connection, runId, {
      status: 'failed',
      registrations,
      filings,
      error: message,
      finishedAt: now().toISOString(),
    });
    return { connectionId: connection.id, status: 'failed', registrations, filings, error: message };
  }
}

export type AdapterResolver = (connection: ProviderConnection) => ProviderAdapter;

/**
 * Sync many connections. Each is isolated: a missing credential, an outage or a bug affecting
 * one client or provider never stops the others.
 */
export async function syncAll(
  connections: ProviderConnection[],
  resolveAdapter: AdapterResolver,
  store: SyncStore,
  opts: SyncOptions & {
    concurrency?: number;
    /** Checked before each connection is started; once true, the rest are marked 'deferred'. */
    shouldStop?: () => boolean;
  } = {},
): Promise<SyncResult[]> {
  const results: SyncResult[] = new Array(connections.length);
  const limit = Math.max(1, opts.concurrency ?? 4);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= connections.length) return;
      const connection = connections[i]!;
      if (opts.shouldStop?.()) {
        results[i] = {
          connectionId: connection.id,
          status: 'deferred',
          registrations: 0,
          filings: 0,
          error: 'time budget exhausted before this connection was reached',
        };
        continue;
      }
      try {
        const adapter = resolveAdapter(connection);
        results[i] = await syncConnection(connection, adapter, store, opts);
      } catch (err) {
        // Adapter could not even be built (e.g. credential missing), or the store itself failed.
        results[i] = {
          connectionId: connection.id,
          status: 'failed',
          registrations: 0,
          filings: 0,
          error: describeError(err),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, connections.length) }, () => worker()));
  return results;
}

function describeError(err: unknown): string {
  if (err instanceof ProviderError) return `${err.kind}: ${err.message}`;
  return 'unexpected error during sync';
}
