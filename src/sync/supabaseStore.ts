import type { SupabaseClient } from '@supabase/supabase-js';
import type { CanonicalFiling, CanonicalRegistration, ProviderConnection } from '../core/types.ts';
import { AlreadyRunningError, type RunOutcome, type SyncStore } from './sync.ts';

const CHUNK = 500;

/**
 * Supabase implementation of SyncStore. Construct it with a SERVICE-ROLE client, server-side only:
 *   createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
 *
 * NOTE: written against the schema in supabase/migrations/0001_init.sql but not yet run against a
 * live Supabase project. Exercise it once against a staging project before relying on it.
 */
export class SupabaseStore implements SyncStore {
  private readonly db: SupabaseClient;

  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async startRun(connection: ProviderConnection): Promise<string> {
    const { data, error } = await this.db
      .from('sync_runs')
      .insert({ connection_id: connection.id })
      .select('id')
      .single();
    // 23505 = unique_violation: the sync_runs_one_running index says another sync is in flight.
    if (error && (error as { code?: string }).code === '23505') throw new AlreadyRunningError(connection.id);
    if (error || !data) throw new Error(`startRun failed: ${error?.message ?? 'no row returned'}`);
    return data.id as string;
  }

  async upsertRegistrations(
    connection: ProviderConnection,
    rows: CanonicalRegistration[],
    syncedAt: string,
  ): Promise<number> {
    const records = rows.map((r) => ({
      connection_id: connection.id,
      tenant_id: connection.tenantId,
      jurisdiction: r.jurisdiction,
      tax_id: r.taxId,
      started_at: r.startedAt,
      ended_at: r.endedAt,
      frequency: r.frequency,
      raw_frequency_code: r.rawFrequencyCode,
      synced_at: syncedAt,
    }));
    await this.upsertChunked('registrations', records, 'connection_id,jurisdiction,started_at');
    return records.length;
  }

  async upsertFilings(connection: ProviderConnection, rows: CanonicalFiling[], syncedAt: string): Promise<number> {
    const records = rows.map((f) => ({
      connection_id: connection.id,
      tenant_id: connection.tenantId,
      external_id: f.externalId,
      jurisdiction: f.jurisdiction,
      period_code: f.periodCode,
      period_name: f.periodName,
      frequency: f.frequency,
      raw_frequency_code: f.rawFrequencyCode,
      due_on: f.dueOn,
      is_completed: f.isCompleted,
      estimated_tax_due: f.estimatedTaxDue,
      return_confirmation: f.returnConfirmation,
      payment_confirmation: f.paymentConfirmation,
      amount_paid: f.amountPaid,
      documents: f.documents,
      synced_at: syncedAt,
    }));
    await this.upsertChunked('filings', records, 'connection_id,external_id');
    return records.length;
  }

  async finishRun(connection: ProviderConnection, runId: string, outcome: RunOutcome): Promise<void> {
    const run = await this.db
      .from('sync_runs')
      .update({
        finished_at: outcome.finishedAt,
        status: outcome.status,
        registrations_upserted: outcome.registrations,
        filings_upserted: outcome.filings,
        error: outcome.error,
      })
      .eq('id', runId);
    if (run.error) throw new Error(`finishRun (run) failed: ${run.error.message}`);

    // last_synced_at advances ONLY on success so the dashboard's "as of" time stays honest.
    const patch: Record<string, unknown> = {
      last_sync_status: outcome.status,
      last_sync_error: outcome.error,
    };
    if (outcome.status === 'succeeded') patch['last_synced_at'] = outcome.finishedAt;
    const conn = await this.db.from('provider_connections').update(patch).eq('id', connection.id);
    if (conn.error) throw new Error(`finishRun (connection) failed: ${conn.error.message}`);
  }

  private async upsertChunked(table: string, records: Record<string, unknown>[], onConflict: string): Promise<void> {
    for (let i = 0; i < records.length; i += CHUNK) {
      const { error } = await this.db.from(table).upsert(records.slice(i, i + CHUNK), { onConflict });
      if (error) throw new Error(`upsert into ${table} failed: ${error.message}`);
    }
  }
}
