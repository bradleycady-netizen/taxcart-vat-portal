import type { Env } from '../providers/registry.ts';

export interface AppConfig {
  /** Origins allowed to make state-changing requests (e.g. https://portal.taxcart.example). */
  appOrigins: string[];
  /** True when every origin is https. Controls the Secure flag and the __Host- cookie prefix. */
  secureCookies: boolean;
  /** Secret the scheduler must present. Null = cron endpoint disabled (fails closed). */
  cronSecret: string | null;
  /** Key for hashing throttle buckets so the database never holds raw emails or IPs. */
  throttleSecret: string;
  /** How long a login lasts without activity, in days. */
  sessionDays: number;
  /** Stop starting new syncs after this many ms. */
  syncBudgetMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Reads and validates settings. Refuses to start with anything unsafe (plain-http production origin,
 * weak or missing secrets) rather than quietly running insecurely. Reports ALL problems at once.
 */
export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];

  const origins: string[] = [];
  const rawOrigins = (env['APP_ORIGIN'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (rawOrigins.length === 0) problems.push('APP_ORIGIN is required (comma-separated list of allowed origins)');
  for (const raw of rawOrigins) {
    try {
      const u = new URL(raw);
      const local = LOCAL_HOSTS.has(u.hostname);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
        problems.push(`APP_ORIGIN "${raw}" must be https (plain http is only allowed for localhost)`);
      } else {
        origins.push(u.origin);
      }
    } catch {
      problems.push(`APP_ORIGIN "${raw}" is not a valid URL`);
    }
  }

  const throttleSecret = env['AUTH_THROTTLE_SECRET'] ?? '';
  if (throttleSecret.length < 32) problems.push('AUTH_THROTTLE_SECRET is required and must be at least 32 characters');

  const cronSecretRaw = env['CRON_SECRET'] ?? '';
  if (cronSecretRaw !== '' && cronSecretRaw.length < 32) problems.push('CRON_SECRET must be at least 32 characters when set');

  const sessionDays = intSetting(env['SESSION_DAYS'], 14, 1, 90, 'SESSION_DAYS', problems);
  const syncBudgetMs = intSetting(env['SYNC_BUDGET_MS'], 45_000, 1_000, 280_000, 'SYNC_BUDGET_MS', problems);

  if (problems.length > 0) throw new ConfigError(`Invalid configuration:\n - ${problems.join('\n - ')}`);

  return {
    appOrigins: origins,
    secureCookies: origins.every((o) => o.startsWith('https:')),
    cronSecret: cronSecretRaw === '' ? null : cronSecretRaw,
    throttleSecret,
    sessionDays,
    syncBudgetMs,
  };
}

function intSetting(raw: string | undefined, fallback: number, min: number, max: number, name: string, problems: string[]): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number between ${min} and ${max}`);
    return fallback;
  }
  return n;
}
