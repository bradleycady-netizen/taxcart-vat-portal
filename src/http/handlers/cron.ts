import { runScheduledSync, type ConnectionSource } from '../../sync/runner.ts';
import type { AdapterResolver, SyncStore } from '../../sync/sync.ts';
import type { AppConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { HttpError, UUID_RE, errorResponse, jsonResponse, safeEqual, toErrorResponse } from '../util.ts';

export interface CronDeps {
  config: AppConfig;
  source: ConnectionSource;
  store: SyncStore;
  resolveAdapter: AdapterResolver;
  log: Logger;
  nowMs?: () => number;
  now?: () => Date;
}

/**
 * GET or POST /api/cron/sync   (Authorization: Bearer <CRON_SECRET>)
 * Optional ?connection=<uuid> syncs just that one connection (manual trigger).
 *
 * Vercel's scheduler sends the bearer header automatically when CRON_SECRET is set. With no secret
 * configured the endpoint is disabled: it can never be triggered anonymously.
 */
export async function handleSyncCron(request: Request, deps: CronDeps): Promise<Response> {
  try {
    if (request.method !== 'GET' && request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
    if (!deps.config.cronSecret) return errorResponse(503, 'cron_disabled', 'Scheduled sync is not configured.');
    if (!safeEqual(request.headers.get('authorization') ?? '', `Bearer ${deps.config.cronSecret}`)) {
      return errorResponse(401, 'unauthorized', 'Unauthorized.');
    }

    const only = new URL(request.url).searchParams.get('connection');
    if (only !== null && !UUID_RE.test(only)) throw new HttpError(400, 'invalid_input', 'connection must be a UUID.');

    const summary = await runScheduledSync(deps.source, deps.store, deps.resolveAdapter, {
      budgetMs: deps.config.syncBudgetMs,
      log: deps.log,
      ...(only ? { onlyConnectionId: only } : {}),
      ...(deps.nowMs ? { nowMs: deps.nowMs } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });

    // A failed connection is reported, not treated as an error: the scheduler should not retry the whole run.
    return jsonResponse({
      ok: true,
      summary: {
        total: summary.total,
        succeeded: summary.succeeded,
        failed: summary.failed,
        skipped: summary.skipped,
        deferred: summary.deferred,
        reaped: summary.reaped,
        durationMs: summary.durationMs,
      },
      failures: summary.results.filter((r) => r.status === 'failed').map((r) => ({ connectionId: r.connectionId, error: r.error })),
    });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
