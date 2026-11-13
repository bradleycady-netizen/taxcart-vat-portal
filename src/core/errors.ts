/**
 * One error type for every provider, so the sync engine and UI can react to the kind of
 * failure without knowing which vendor produced it.
 */
export type ProviderErrorKind =
  | 'auth' // credential rejected or lacks permission
  | 'not_found' // the requested record does not exist at the provider
  | 'rate_limit' // provider throttled us
  | 'upstream' // provider is down, erroring, or unreachable
  | 'bad_request' // we sent something the provider rejected
  | 'bad_response' // provider answered with a shape we do not understand
  | 'unsupported' // the provider lacks this capability
  | 'config'; // our own setup is wrong (missing credential, unknown provider)

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status: number | null;
  /** True when retrying later could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    kind: ProviderErrorKind,
    provider: string,
    message: string,
    opts: { status?: number | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.kind = kind;
    this.provider = provider;
    this.status = opts.status ?? null;
    this.retryable = kind === 'rate_limit' || kind === 'upstream';
  }
}
