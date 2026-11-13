import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuditEntry {
  tenantId?: string | null;
  actorId?: string | null;
  /** e.g. 'auth.login', 'document.download' */
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
}

/** Append-only record of sensitive actions. record() throws if the entry could not be saved. */
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

/** Writes to the audit_log table. Needs a SERVICE-ROLE client (clients have no write access to it). */
export class SupabaseAuditSink implements AuditSink {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async record(entry: AuditEntry): Promise<void> {
    const { error } = await this.db.from('audit_log').insert({
      tenant_id: entry.tenantId ?? null,
      actor_id: entry.actorId ?? null,
      action: entry.action,
      target: entry.target ?? null,
      detail: entry.detail ?? null,
    });
    if (error) throw new Error(`audit insert failed: ${error.message}`);
  }
}
