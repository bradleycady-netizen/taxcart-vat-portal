import { ProviderError } from '../../core/errors.ts';

export type QueryValue = string | number | boolean | null | undefined;

export interface ZampClientOptions {
  /** Bearer token. Held in memory only; never logged or put in error messages. */
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Retries after the first attempt, for 429 / 5xx / network failures. */
  maxRetries?: number;
  /** Injectable so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.zamp.com';
const PROVIDER = 'zamp';

/**
 * Thin authenticated GET client for Zamp's REST API.
 * Only reads are implemented: the sync engine never writes to the provider.
 */
export class ZampClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(opts: ZampClientOptions) {
    if (!opts.apiKey) throw new ProviderError('config', PROVIDER, 'Zamp API key is empty');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async get(path: string, query: Record<string, QueryValue> = {}): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let lastError: ProviderError | null = null;
    let retryAfterMs: number | null = null; // per-request, so concurrent calls cannot interfere
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(backoffMs(attempt, lastError, retryAfterMs));

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        lastError = new ProviderError('upstream', PROVIDER, `Network error calling ${path}`, { cause });
        continue;
      }

      if (res.ok) {
        try {
          return await res.json();
        } catch (cause) {
          throw new ProviderError('bad_response', PROVIDER, `Non-JSON response from ${path}`, {
            status: res.status,
            cause,
          });
        }
      }

      const err = await this.errorFor(res, path);
      if (!err.retryable) throw err;
      lastError = err;
      retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    }
    throw lastError ?? new ProviderError('upstream', PROVIDER, `Request to ${path} failed`);
  }

  private async errorFor(res: Response, path: string): Promise<ProviderError> {
    let excerpt = '';
    try {
      excerpt = (await res.text()).slice(0, 200);
    } catch {
      /* ignore body read failures */
    }
    const detail = excerpt ? `: ${excerpt}` : '';
    const status = res.status;
    if (status === 401 || status === 403) {
      return new ProviderError('auth', PROVIDER, `Zamp rejected the credential (${status}) on ${path}${detail}`, { status });
    }
    if (status === 404) return new ProviderError('not_found', PROVIDER, `Not found: ${path}${detail}`, { status });
    if (status === 429) return new ProviderError('rate_limit', PROVIDER, `Rate limited on ${path}`, { status });
    if (status >= 500) return new ProviderError('upstream', PROVIDER, `Zamp error ${status} on ${path}${detail}`, { status });
    return new ProviderError('bad_request', PROVIDER, `Zamp rejected the request (${status}) on ${path}${detail}`, { status });
  }
}

function backoffMs(attempt: number, last: ProviderError | null, retryAfterMs: number | null): number {
  if (last?.kind === 'rate_limit' && retryAfterMs !== null) return Math.min(retryAfterMs, 30_000);
  return Math.min(500 * 2 ** (attempt - 1), 8_000);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}
