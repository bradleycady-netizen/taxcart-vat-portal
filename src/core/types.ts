/**
 * Provider-neutral domain model.
 *
 * The UI, database and sync engine only ever see these shapes. Each provider adapter
 * translates its vendor's API into them, so swapping or adding a provider never touches
 * anything outside src/providers/<vendor>/.
 */

export type ProductKey = 'us_sales_tax' | 'eu_vat';

export type FilingFrequency = 'monthly' | 'quarterly' | 'semi_annual' | 'annual' | 'other';

/**
 * What a provider can actually do. The UI reads these flags and hides or degrades features
 * a provider lacks (e.g. show "managed by your tax team" instead of a nexus tracker).
 */
export interface Capabilities {
  registrations: boolean;
  filings: boolean;
  documents: boolean;
  nexusTracking: boolean;
  registrationApproval: boolean;
  webhooks: boolean;
}

/** Per-call context identifying which of the provider's companies we are acting for. */
export interface ProviderContext {
  /**
   * The provider's own ID for this client's company. Null when the credential is already
   * scoped to a single company (e.g. a normal, non-partner key).
   */
  providerCompanyId: string | null;
}

export interface CanonicalRegistration {
  jurisdiction: string;
  taxId: string | null;
  /** ISO date (YYYY-MM-DD). */
  startedAt: string;
  endedAt: string | null;
  frequency: FilingFrequency | null;
  /** The provider's own frequency code, kept so nothing is lost in translation. */
  rawFrequencyCode: string | null;
}

export type DocumentKind = 'return' | 'payment' | 'return_and_payment' | 'template' | 'other';

export interface CanonicalFilingDocument {
  kind: DocumentKind;
}

export interface CanonicalFiling {
  /** Stable provider-side identity for upserts, e.g. "KS:2025-JAN". */
  externalId: string;
  jurisdiction: string;
  periodCode: string;
  periodName: string;
  frequency: FilingFrequency | null;
  rawFrequencyCode: string | null;
  /** ISO date. */
  dueOn: string;
  isCompleted: boolean;
  estimatedTaxDue: number | null;
  returnConfirmation: string | null;
  paymentConfirmation: string | null;
  amountPaid: number | null;
  /** Which documents exist. Links are NOT stored: they expire, so fetch on demand. */
  documents: CanonicalFilingDocument[];
}

/** Enough to re-locate one document at the provider and mint a fresh link. */
export interface DocumentRef {
  jurisdiction: string;
  periodCode: string;
  dueOn: string;
  kind: DocumentKind;
}

export interface DocumentLink {
  url: string;
  /** ISO timestamp after which the link stops working, if known. */
  expiresAt: string | null;
}

export type NexusState = 'registered' | 'approaching' | 'exposure' | 'unregistered';

/** Only returned by providers whose capabilities.nexusTracking is true. */
export interface CanonicalNexus {
  jurisdiction: string;
  state: NexusState;
  salesAmount: number | null;
  salesThreshold: number | null;
  transactionCount: number | null;
  transactionThreshold: number | null;
  thresholdPeriod: string | null;
  exclusions: string[];
  /** ISO date the threshold was met, if it has been. */
  metOn: string | null;
}

export interface ListFilingsOptions {
  jurisdiction?: string;
  /** ISO date, inclusive. */
  minDueOn?: string;
  maxDueOn?: string;
  isCompleted?: boolean;
}

/** The contract every provider implements. */
export interface ProviderAdapter {
  /** Matches provider_connections.provider_key. */
  readonly key: string;
  readonly capabilities: Capabilities;

  /** Cheap authenticated call proving the credential works. Throws ProviderError on failure. */
  healthCheck(ctx: ProviderContext): Promise<void>;

  listRegistrations(ctx: ProviderContext): Promise<CanonicalRegistration[]>;
  listFilings(ctx: ProviderContext, options?: ListFilingsOptions): Promise<CanonicalFiling[]>;

  /** Mint a fresh, short-lived download link for one filing document. */
  getDocumentLink(ctx: ProviderContext, ref: DocumentRef): Promise<DocumentLink>;

  /** Present only when capabilities.nexusTracking is true. */
  listNexus?(ctx: ProviderContext): Promise<CanonicalNexus[]>;
}

/** A row of provider_connections, as the backend sees it. */
export interface ProviderConnection {
  id: string;
  tenantId: string;
  product: ProductKey;
  providerKey: string;
  providerCompanyId: string | null;
  /** Name of the env var holding the credential. Null when the token is stored encrypted instead (credentialEnc). */
  credentialRef: string | null;
  /** The credential, encrypted (see core/secretbox.ts). Null when credentialRef names an env var instead. */
  credentialEnc?: string | null;
  status: 'active' | 'paused' | 'disconnected';
}
