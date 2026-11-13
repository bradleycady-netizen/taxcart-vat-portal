import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProductKey, ProviderConnection } from '../core/types.ts';
import type { ConnectionSource } from './runner.ts';

/** Columns needed to build a ProviderConnection. Explicit, never `select *`. */
export const CONNECTION_COLUMNS = 'id,tenant_id,product,provider_key,provider_company_id,credential_ref,credential_enc,status';

export function connectionFromRow(row: Record<string, unknown>): ProviderConnection {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    product: row['product'] as ProductKey,
    providerKey: String(row['provider_key']),
    providerCompanyId: (row['provider_company_id'] as string | null) ?? null,
    credentialRef: (row['credential_ref'] as string | null) ?? null,
    credentialEnc: (row['credential_enc'] as string | null) ?? null,
    status: row['status'] as ProviderConnection['status'],
  };
}

/**
 * Supabase implementation of ConnectionSource. Construct with a SERVICE-ROLE client, server-side only.
 *
 * NOTE: like SupabaseStore, written against migrations 0001/0002 but not yet run against a live project.
 */
export class SupabaseConnectionSource implements ConnectionSource {
  private readonly db: SupabaseClient;
  /** Runs older than this are assumed dead. Must comfortably exceed the function's maximum duration. */
  private readonly staleAfter: string;

  constructor(db: SupabaseClient, staleAfter = '15 minutes') {
    this.db = db;
    this.staleAfter = staleAfter;
  }

  async listActive(): Promise<ProviderConnection[]> {
    const { data, error } = await this.db
      .from('provider_connections')
      .select(CONNECTION_COLUMNS)
      .eq('status', 'active')
      .order('last_synced_at', { ascending: true, nullsFirst: true });
    if (error) throw new Error(`listActive failed: ${error.message}`);
    return (data ?? []).map((r) => connectionFromRow(r as Record<string, unknown>));
  }

  async getActive(id: string): Promise<ProviderConnection | null> {
    const { data, error } = await this.db
      .from('provider_connections')
      .select(CONNECTION_COLUMNS)
      .eq('id', id)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw new Error(`getActive failed: ${error.message}`);
    return data ? connectionFromRow(data as Record<string, unknown>) : null;
  }

  async reapStale(): Promise<number> {
    const { data, error } = await this.db.rpc('reap_stale_sync_runs', { p_max_age: this.staleAfter });
    if (error) throw new Error(`reapStale failed: ${error.message}`);
    return Number(data ?? 0);
  }

  async purgeThrottle(): Promise<number> {
    const { data, error } = await this.db.rpc('purge_auth_throttle', { p_older_than: '1 day' });
    if (error) throw new Error(`purgeThrottle failed: ${error.message}`);
    return Number(data ?? 0);
  }
}
