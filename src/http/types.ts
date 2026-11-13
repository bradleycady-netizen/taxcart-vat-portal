import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdapterResolver } from '../sync/sync.ts';
import type { AuditSink } from './audit.ts';
import type { AuthApi } from './authApi.ts';
import type { AppConfig } from './config.ts';
import type { Throttle } from './throttle.ts';

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

/** Everything a request handler needs, injected so handlers can be tested without a network. */
export interface Deps {
  config: AppConfig;
  auth: AuthApi;
  throttle: Throttle;
  audit: AuditSink;
  /**
   * Database client acting AS the signed-in user: row-level security applies.
   * Use this for everything a client may see.
   */
  userDb(accessToken: string): SupabaseClient;
  /**
   * Service-role client: BYPASSES row-level security. Use only after the request has been
   * authorised some other way (e.g. a filing was already fetched through userDb).
   */
  serviceDb: SupabaseClient;
  resolveAdapter: AdapterResolver;
  fetchImpl: typeof fetch;
  now(): Date;
  /** Key for encrypting stored provider tokens (CREDENTIAL_ENCRYPTION_KEY). Undefined = token storage not configured. */
  credentialKey?: string | undefined;
  /** Operational events. Never pass emails, codes, tokens or provider error bodies that name the vendor to clients. */
  log: Logger;
}
