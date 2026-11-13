import type { SupabaseClient } from '@supabase/supabase-js';

/** Attempt limiter. State lives in the database because serverless functions share no memory. */
export interface Throttle {
  /** Records an attempt. Returns false (and records nothing) when the limit for this window is reached. */
  hit(bucket: string, limit: number, windowSeconds: number): Promise<boolean>;
  /** Forget a bucket, e.g. after a successful login. */
  reset(bucket: string): Promise<void>;
}

/** Implements Throttle with the auth_throttle_* functions from migration 0002. Needs a SERVICE-ROLE client. */
export class SupabaseThrottle implements Throttle {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async hit(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    const { data, error } = await this.db.rpc('auth_throttle_hit', {
      p_bucket: bucket,
      p_limit: limit,
      p_window: `${windowSeconds} seconds`,
    });
    if (error) throw new Error(`throttle hit failed: ${error.message}`); // fail closed: caller returns 503
    return data === true;
  }

  async reset(bucket: string): Promise<void> {
    const { error } = await this.db.rpc('auth_throttle_reset', { p_bucket: bucket });
    if (error) throw new Error(`throttle reset failed: ${error.message}`);
  }
}
