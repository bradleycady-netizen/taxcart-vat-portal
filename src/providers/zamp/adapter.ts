import { ProviderError } from '../../core/errors.ts';
import type {
  Capabilities,
  CanonicalFiling,
  CanonicalRegistration,
  DocumentLink,
  DocumentRef,
  ListFilingsOptions,
  ProviderAdapter,
  ProviderContext,
} from '../../core/types.ts';
import { ZampClient, type ZampClientOptions } from './client.ts';
import {
  mapDocumentKind,
  mapFiling,
  mapRegistration,
  parseFilingsPage,
  parseRegistrations,
  type ZampFiling,
} from './mapper.ts';

/** Zamp documents that file links expire after 1 hour; we report a little less to stay safe. */
const LINK_TTL_MS = 55 * 60 * 1000;
/** Guard against a provider that never stops paginating. */
const MAX_PAGES = 500;

export interface ZampAdapterOptions extends ZampClientOptions {
  /** Injectable clock for tests. */
  now?: () => number;
}

export class ZampAdapter implements ProviderAdapter {
  readonly key = 'zamp';

  /**
   * Flip these only after Zamp confirms the capability in writing (see the question list).
   * Today the public docs describe no nexus-progress endpoint, no approval action and no webhooks.
   */
  readonly capabilities: Capabilities = {
    registrations: true,
    filings: true,
    documents: true,
    nexusTracking: false,
    registrationApproval: false,
    webhooks: false,
  };

  private readonly client: ZampClient;
  private readonly now: () => number;

  constructor(opts: ZampAdapterOptions) {
    this.client = new ZampClient(opts);
    this.now = opts.now ?? Date.now;
  }

  async healthCheck(ctx: ProviderContext): Promise<void> {
    await this.client.get('/companies', { companyId: ctx.providerCompanyId });
  }

  async listRegistrations(ctx: ProviderContext): Promise<CanonicalRegistration[]> {
    const body = await this.client.get('/registrations', { companyId: ctx.providerCompanyId });
    return parseRegistrations(body).map(mapRegistration);
  }

  async listFilings(ctx: ProviderContext, options: ListFilingsOptions = {}): Promise<CanonicalFiling[]> {
    return (await this.fetchRawFilings(ctx, options)).map(mapFiling);
  }

  async getDocumentLink(ctx: ProviderContext, ref: DocumentRef): Promise<DocumentLink> {
    // Links expire, so we never store them: re-query this exact filing and mint a fresh one.
    const filings = await this.fetchRawFilings(ctx, {
      jurisdiction: ref.jurisdiction,
      minDueOn: ref.dueOn,
      maxDueOn: ref.dueOn,
    });
    const filing = filings.find((f) => f.periodCode === ref.periodCode && f.dueOn === ref.dueOn);
    const file = filing?.artifacts
      .flatMap((a) => a.files)
      .find((f) => mapDocumentKind(f.type) === ref.kind);
    if (!file) {
      throw new ProviderError(
        'not_found',
        this.key,
        `No ${ref.kind} document for ${ref.jurisdiction} ${ref.periodCode} at the provider`,
      );
    }
    return { url: file.signedUrl, expiresAt: new Date(this.now() + LINK_TTL_MS).toISOString() };
  }

  private async fetchRawFilings(ctx: ProviderContext, options: ListFilingsOptions): Promise<ZampFiling[]> {
    const all: ZampFiling[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.client.get('/filings', {
        companyId: ctx.providerCompanyId,
        state: options.jurisdiction,
        minDueOn: options.minDueOn,
        maxDueOn: options.maxDueOn,
        isCompleted: options.isCompleted,
        cursor,
      });
      const parsed = parseFilingsPage(body);
      all.push(...parsed.filings);
      if (parsed.nextCursor === null) return all;
      if (seen.has(parsed.nextCursor)) {
        throw new ProviderError('bad_response', this.key, 'Provider returned a repeating pagination cursor');
      }
      seen.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
    throw new ProviderError('bad_response', this.key, `Pagination exceeded ${MAX_PAGES} pages`);
  }
}
