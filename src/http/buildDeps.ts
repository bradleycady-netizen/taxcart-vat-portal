import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildAdapter, type Env } from '../providers/registry.ts';
import { SupabaseConnectionSource } from '../sync/supabaseSource.ts';
import { SupabaseStore } from '../sync/supabaseStore.ts';
import { SupabaseAuditSink } from './audit.ts';
import { SupabaseAuthApi } from './authApi.ts';
import { loadConfig } from './config.ts';
import type { CronDeps } from './handlers/cron.ts';
import type { StaffDeps } from './handlers/staff.ts';
import { SupabaseThrottle } from './throttle.ts';
import type { Deps, Logger } from './types.ts';

/**
 * The only file that creates real Supabase clients. Deliberately thin: everything else takes its
 * dependencies as arguments, which is what makes it testable without a network.
 *
 * NOT covered by the automated tests (the Supabase package could not be installed where the tests were
 * written). Exercise it against a staging project before relying on it.
 */

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

const log: Logger = (event, fields) => {
  // One JSON line per event: easy to search in Vercel's logs. Callers never pass emails, codes or tokens.
  console.log(JSON.stringify({ event, ...fields }));
};

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

let cached: { env: Env; deps: Deps; cron: CronDeps; staff: StaffDeps } | undefined;

export function buildDeps(env: Env): { deps: Deps; cron: CronDeps; staff: StaffDeps } {
  if (cached && cached.env === env) return cached;

  const url = required(env, 'SUPABASE_URL');
  const anonKey = required(env, 'SUPABASE_ANON_KEY');
  const serviceKey = required(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const config = loadConfig(env);

  const serviceDb = createClient(url, serviceKey, { auth: NO_SESSION });
  // A fresh client per call, so one visitor's session can never be seen by another.
  const anonClient = (): SupabaseClient => createClient(url, anonKey, { auth: NO_SESSION });
  const userDb = (accessToken: string): SupabaseClient =>
    createClient(url, anonKey, { auth: NO_SESSION, global: { headers: { Authorization: `Bearer ${accessToken}` } } });

  const resolveAdapter = (c: Parameters<typeof buildAdapter>[0]) => buildAdapter(c, env);

  const deps: Deps = {
    config,
    auth: new SupabaseAuthApi(anonClient, serviceDb, log),
    throttle: new SupabaseThrottle(serviceDb),
    audit: new SupabaseAuditSink(serviceDb),
    userDb,
    serviceDb,
    resolveAdapter,
    fetchImpl: fetch,
    now: () => new Date(),
    credentialKey: env['CREDENTIAL_ENCRYPTION_KEY'],
    log,
  };
  const cron: CronDeps = {
    config,
    source: new SupabaseConnectionSource(serviceDb),
    store: new SupabaseStore(serviceDb),
    resolveAdapter,
    log,
  };
  const staff: StaffDeps = { source: cron.source, store: cron.store };
  cached = { env, deps, cron, staff };
  return cached;
}
