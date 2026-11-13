import { ProviderError } from '../../core/errors.ts';
import type {
  Capabilities,
  CanonicalFiling,
  CanonicalNexus,
  CanonicalRegistration,
  DocumentLink,
  DocumentRef,
  ListFilingsOptions,
  ProviderAdapter,
  ProviderContext,
} from '../../core/types.ts';

export interface MockAdapterOptions {
  key?: string;
  capabilities?: Partial<Capabilities>;
  registrations?: CanonicalRegistration[];
  filings?: CanonicalFiling[];
  nexus?: CanonicalNexus[];
}

/**
 * A fake provider used for two jobs:
 *  1. Proving in tests that two providers can serve different products at the same time.
 *  2. A template for the real VAT vendor's adapter: same interface, different data source.
 * Set `failWith` to simulate an outage.
 */
export class MockAdapter implements ProviderAdapter {
  readonly key: string;
  readonly capabilities: Capabilities;
  failWith: ProviderError | null = null;
  /** Every context this adapter was called with, so tests can check tenant routing. */
  readonly calls: ProviderContext[] = [];

  private readonly registrations: CanonicalRegistration[];
  private readonly filings: CanonicalFiling[];
  private readonly nexus: CanonicalNexus[];

  constructor(opts: MockAdapterOptions = {}) {
    this.key = opts.key ?? 'mock';
    this.capabilities = {
      registrations: true,
      filings: true,
      documents: true,
      nexusTracking: false,
      registrationApproval: false,
      webhooks: false,
      ...opts.capabilities,
    };
    this.registrations = opts.registrations ?? [];
    this.filings = opts.filings ?? [];
    this.nexus = opts.nexus ?? [];
  }

  private enter(ctx: ProviderContext): void {
    this.calls.push(ctx);
    if (this.failWith) throw this.failWith;
  }

  async healthCheck(ctx: ProviderContext): Promise<void> {
    this.enter(ctx);
  }

  async listRegistrations(ctx: ProviderContext): Promise<CanonicalRegistration[]> {
    this.enter(ctx);
    return structuredClone(this.registrations);
  }

  async listFilings(ctx: ProviderContext, options: ListFilingsOptions = {}): Promise<CanonicalFiling[]> {
    this.enter(ctx);
    return structuredClone(
      this.filings.filter(
        (f) =>
          (options.jurisdiction === undefined || f.jurisdiction === options.jurisdiction) &&
          (options.isCompleted === undefined || f.isCompleted === options.isCompleted) &&
          (options.minDueOn === undefined || f.dueOn >= options.minDueOn) &&
          (options.maxDueOn === undefined || f.dueOn <= options.maxDueOn),
      ),
    );
  }

  async getDocumentLink(ctx: ProviderContext, ref: DocumentRef): Promise<DocumentLink> {
    this.enter(ctx);
    const filing = this.filings.find((f) => f.jurisdiction === ref.jurisdiction && f.periodCode === ref.periodCode);
    if (!filing || !filing.documents.some((d) => d.kind === ref.kind)) {
      throw new ProviderError('not_found', this.key, 'No such document');
    }
    return { url: `https://files.example.invalid/${ref.jurisdiction}/${ref.periodCode}/${ref.kind}.pdf`, expiresAt: null };
  }

  async listNexus(ctx: ProviderContext): Promise<CanonicalNexus[]> {
    this.enter(ctx);
    if (!this.capabilities.nexusTracking) {
      throw new ProviderError('unsupported', this.key, 'Nexus tracking is not supported');
    }
    return structuredClone(this.nexus);
  }
}
