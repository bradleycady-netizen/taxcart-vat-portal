import type { ProviderConnection } from '../core/types.ts';
import { syncAll, type AdapterResolver, type SyncResult, type SyncStore } from './sync.ts';

/** Where the runner finds work, and the housekeeping it does around a run. */
export interface ConnectionSource {
  /** Active connections, STALEST FIRST (never-synced first), so a short run still helps whoever waited longest. */
  listActive(): Promise<ProviderConnection[]>;
  /** One active connection, for a manual single-client sync. */
  getActive(id: string): Promise<ProviderConnection | null>;
  /** Mark runs that never finished (crashed or timed out) as failed so they stop blocking. Returns how many. */
  reapStale(): Promise<number>;
  /** Delete old login-throttle rows. Returns how many. */
  purgeThrottle(): Promise<number>;
}

export interface RunnerOptions {
  /**
   * Stop STARTING new connections after this many ms. Must leave room (inside the function's
   * maximum duration) for the connections already in flight to finish.
   */
  budgetMs: number;
  concurrency?: number;
  /** Sync only this connection (manual trigger). Omit to sync everything. */
  onlyConnectionId?: string;
  /** Injectable clocks for tests. */
  nowMs?: () => number;
  now?: () => Date;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface RunSummary {
  reaped: number;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  deferred: number;
  durationMs: number;
  results: SyncResult[];
}

/**
 * One scheduled pass: clean up crashed runs, sync every active connection (stalest first, within a
 * time budget), then do housekeeping. Housekeeping problems are logged, never fatal.
 */
export async function runScheduledSync(
  source: ConnectionSource,
  store: SyncStore,
  resolveAdapter: AdapterResolver,
  opts: RunnerOptions,
): Promise<RunSummary> {
  const nowMs = opts.nowMs ?? Date.now;
  const log = opts.log ?? (() => {});
  const startedAt = nowMs();

  let reaped = 0;
  try {
    reaped = await source.reapStale();
    if (reaped > 0) log('sync.reaped_stale_runs', { count: reaped });
  } catch {
    log('sync.reap_failed');
  }

  let connections: ProviderConnection[];
  if (opts.onlyConnectionId) {
    const one = await source.getActive(opts.onlyConnectionId);
    connections = one ? [one] : [];
  } else {
    connections = await source.listActive();
  }

  const results = await syncAll(connections, resolveAdapter, store, {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    shouldStop: () => nowMs() - startedAt >= opts.budgetMs,
  });

  try {
    await source.purgeThrottle();
  } catch {
    log('sync.purge_throttle_failed');
  }

  const count = (s: SyncResult['status']) => results.filter((r) => r.status === s).length;
  const summary: RunSummary = {
    reaped,
    total: results.length,
    succeeded: count('succeeded'),
    failed: count('failed'),
    skipped: count('skipped'),
    deferred: count('deferred'),
    durationMs: nowMs() - startedAt,
    results,
  };
  log('sync.run_complete', {
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    skipped: summary.skipped,
    deferred: summary.deferred,
    durationMs: summary.durationMs,
  });
  return summary;
}
