import { ProviderError } from '../../core/errors.ts';
import type { DocumentKind, ProductKey } from '../../core/types.ts';
import { CONNECTION_COLUMNS, connectionFromRow } from '../../sync/supabaseSource.ts';
import { LIMITS } from '../limits.ts';
import { authenticate } from '../session.ts';
import type { Deps } from '../types.ts';
import { HttpError, UUID_RE, bucketKey, errorResponse, jsonResponse, requireMethod, toErrorResponse } from '../util.ts';
import { syncStatus } from './auth.ts';

const PRODUCTS = new Set<ProductKey>(['us_sales_tax', 'eu_vat']);
const DOCUMENT_KINDS = new Set<DocumentKind>(['return', 'payment', 'return_and_payment', 'template', 'other']);

const NOT_FOUND = () => new HttpError(404, 'not_found', 'Not found.');

interface ListQuery {
  tenant: string;
  product: ProductKey;
  limit: number;
  offset: number;
}

function parseListQuery(url: URL): ListQuery {
  const tenant = url.searchParams.get('tenant') ?? '';
  const product = url.searchParams.get('product') ?? '';
  if (!UUID_RE.test(tenant)) throw new HttpError(400, 'invalid_input', 'A valid tenant is required.');
  if (!PRODUCTS.has(product as ProductKey)) throw new HttpError(400, 'invalid_input', 'A valid product is required.');
  const limit = intParam(url, 'limit', 50, 1, 200);
  const offset = intParam(url, 'offset', 0, 0, 100_000);
  return { tenant, product: product as ProductKey, limit, offset };
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'invalid_input', `${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

type Row = Record<string, unknown>;

/**
 * Finds which connections hold this client's data for a product, through the client-safe view.
 * 404 covers "not your tenant", "no such tenant" and "no such product" identically, so nothing can be probed.
 */
async function connectionsFor(db: ReturnType<Deps['userDb']>, q: ListQuery): Promise<{ ids: string[]; sync: { asOf: unknown; status: string } | null }> {
  const { data, error } = await db
    .from('tenant_products')
    .select('connection_id,is_active,last_synced_at,last_sync_status')
    .eq('tenant_id', q.tenant)
    .eq('product', q.product);
  if (error) throw new Error('could not load products');
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) throw NOT_FOUND();
  const current = rows.find((r) => r['is_active'] === true);
  return {
    // Older (replaced) connections are included so history survives a change of provider.
    ids: rows.map((r) => String(r['connection_id'])),
    sync: current ? { asOf: current['last_synced_at'] ?? null, status: syncStatus(current as never) } : null,
  };
}

const FILING_COLUMNS =
  'id,jurisdiction,period_code,period_name,frequency,due_on,is_completed,estimated_tax_due,return_confirmation,payment_confirmation,amount_paid,documents';
const REGISTRATION_COLUMNS = 'jurisdiction,tax_id,started_at,ended_at,frequency,raw_frequency_code';

export function documentHref(filingId: string, kind: string): string {
  return `/api/documents?filing=${encodeURIComponent(filingId)}&kind=${encodeURIComponent(kind)}`;
}

/** Document kinds that only staff may see. Zamp's "template" is undocumented (possibly a working or draft file), so it is
 * kept from clients until Zamp confirms what it is. To show it to clients, empty this set. */
const STAFF_ONLY_KINDS = new Set<string>(['template']);

function documentsOf(value: unknown, filingId: string, isStaff: boolean): { kind: string; href: string }[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: { kind: string; href: string }[] = [];
  for (const d of value) {
    const kind = (d as { kind?: unknown } | null)?.kind;
    if (typeof kind === 'string' && DOCUMENT_KINDS.has(kind as DocumentKind) && !seen.has(kind) && (isStaff || !STAFF_ONLY_KINDS.has(kind))) {
      seen.add(kind);
      out.push({ kind, href: documentHref(filingId, kind) });
    }
  }
  return out;
}

/** GET /api/filings?tenant=<id>&product=<key>&limit=&offset= */
export async function listFilings(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'GET');
    const a = await authenticate(request, deps);
    if (!a.ok) return a.response;
    const q = parseListQuery(new URL(request.url));

    const db = deps.userDb(a.accessToken); // row-level security: only this client's rows can come back
    const { ids, sync } = await connectionsFor(db, q);

    const { data, error } = await db
      .from('filings')
      .select(FILING_COLUMNS)
      .in('connection_id', ids)
      .order('due_on', { ascending: false })
      .order('id', { ascending: true })
      .range(q.offset, q.offset + q.limit); // one extra row tells us whether there is another page
    if (error) throw new Error('could not load filings');

    const rows = (data ?? []) as Row[];
    const page = rows.slice(0, q.limit);
    return jsonResponse(
      {
        filings: page.map((f) => ({
          id: f['id'],
          jurisdiction: f['jurisdiction'],
          periodCode: f['period_code'],
          periodName: f['period_name'],
          frequency: f['frequency'] ?? null,
          dueOn: f['due_on'],
          isCompleted: f['is_completed'],
          estimatedTaxDue: f['estimated_tax_due'] ?? null,
          returnConfirmation: f['return_confirmation'] ?? null,
          paymentConfirmation: f['payment_confirmation'] ?? null,
          amountPaid: f['amount_paid'] ?? null,
          documents: documentsOf(f['documents'], String(f['id']), a.user.isStaff),
        })),
        sync,
        page: { limit: q.limit, offset: q.offset, hasMore: rows.length > q.limit },
      },
      200,
      { setCookies: a.setCookies },
    );
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

/** GET /api/registrations?tenant=<id>&product=<key> */
export async function listRegistrations(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'GET');
    const a = await authenticate(request, deps);
    if (!a.ok) return a.response;
    const q = parseListQuery(new URL(request.url));

    const db = deps.userDb(a.accessToken);
    const { ids, sync } = await connectionsFor(db, q);

    const { data, error } = await db
      .from('registrations')
      .select(REGISTRATION_COLUMNS)
      .in('connection_id', ids)
      .order('jurisdiction', { ascending: true })
      .order('started_at', { ascending: false })
      .range(q.offset, q.offset + q.limit);
    if (error) throw new Error('could not load registrations');

    const rows = (data ?? []) as Row[];
    return jsonResponse(
      {
        registrations: rows.slice(0, q.limit).map((r) => ({
          jurisdiction: r['jurisdiction'],
          taxId: r['tax_id'] ?? null,
          startedAt: r['started_at'],
          endedAt: r['ended_at'] ?? null,
          frequency: r['frequency'] ?? null,
          // The provider's own code is only useful when we could not translate it.
          ...(r['frequency'] === 'other' ? { frequencyCode: r['raw_frequency_code'] ?? null } : {}),
        })),
        sync,
        page: { limit: q.limit, offset: q.offset, hasMore: rows.length > q.limit },
      },
      200,
      { setCookies: a.setCookies },
    );
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

/** CSV cells starting with these are treated as formulas by spreadsheet programs; a leading apostrophe neutralises that. */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const FREQ_LABEL: Record<string, string> = { monthly: 'Monthly', quarterly: 'Quarterly', semi_annual: 'Semi-annual', annual: 'Annual', other: 'Other' };
const EXPORT_LIMIT = 5000;

/**
* GET /api/filings?format=csv&tenant=<id>&product=<key>
 * Every filing the signed-in person can see for that service, as a spreadsheet-friendly CSV. Same rules as the filings
 * list: row-level security decides what comes back, and nothing about the provider is included.
 */
export async function exportFilings(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'GET');
    const a = await authenticate(request, deps);
    if (!a.ok) return a.response;
    const url = new URL(request.url);
    const q = parseListQuery(url);

    try {
      const rule = LIMITS.download.perUser;
      const allowed = await deps.throttle.hit(bucketKey(deps.config.throttleSecret, 'dl-user', a.user.id), rule.limit, rule.windowSeconds);
      if (!allowed) {
        return errorResponse(429, 'rate_limited', 'Too many downloads. Please wait a few minutes and try again.', {
          headers: { 'Retry-After': String(rule.windowSeconds) },
        });
      }
    } catch {
      throw new HttpError(503, 'unavailable', 'We could not complete that right now. Please try again shortly.');
    }

    const db = deps.userDb(a.accessToken);
    const { ids } = await connectionsFor(db, q);
    const { data, error } = await db
      .from('filings')
      .select('tenant_id,jurisdiction,period_code,period_name,frequency,due_on,is_completed,estimated_tax_due,amount_paid,return_confirmation,payment_confirmation')
      .in('connection_id', ids)
      .order('due_on', { ascending: false })
      .order('id', { ascending: true })
      .range(0, EXPORT_LIMIT - 1);
    if (error) throw new Error('could not load filings');
    const rows = (data ?? []) as Row[];

    try {
      await deps.audit.record({ tenantId: q.tenant, actorId: a.user.id, action: 'filings.export', target: `tenant:${q.tenant}:${q.product}`, detail: { rows: rows.length } });
    } catch {
      deps.log('audit.export_not_recorded');
      throw new HttpError(503, 'unavailable', 'We could not complete that right now. Please try again shortly.');
    }

    const today = deps.now().toISOString().slice(0, 10);
    const money = q.product === 'us_sales_tax' ? ' (USD)' : '';
    const header = ['Jurisdiction', 'Period', 'Frequency', 'Due date', 'Status', `Estimated tax${money}`, `Amount paid${money}`, 'Return confirmation', 'Payment confirmation'];
    const lines = [header.map(csvCell).join(',')];
    for (const f of rows) {
      const status = f['is_completed'] === true ? 'Filed' : String(f['due_on'] ?? '') < today ? 'Past due date' : 'Upcoming';
      const amount = (v: unknown) => (v === null || v === undefined || v === '' ? '' : Number(v).toFixed(2));
      lines.push([
        f['jurisdiction'], f['period_name'] || f['period_code'], FREQ_LABEL[String(f['frequency'])] ?? '', f['due_on'], status,
        amount(f['estimated_tax_due']), amount(f['amount_paid']), f['return_confirmation'], f['payment_confirmation'],
      ].map(csvCell).join(','));
    }

    const headers = new Headers({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="filings-${q.product}-${today}.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    for (const c of a.setCookies) headers.append('Set-Cookie', c);
    // A leading byte-order mark makes Excel read the file as UTF-8.
    return new Response('\uFEFF' + lines.join('\r\n') + '\r\n', { status: 200, headers });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

const SAFE_TYPES: Record<string, string> = {
  'application/pdf': '.pdf',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/zip': '.zip',
};

const UNAVAILABLE_DOC = () => new HttpError(502, 'document_unavailable', 'That document is temporarily unavailable. Please try again shortly.');

/**
 * GET /api/documents?filing=<id>&kind=<kind>
 *
 * The file is fetched by OUR server and streamed to the client. The client is never redirected to, or told,
 * the provider's link, so the vendor stays hidden and a one-hour link cannot be shared around.
 */
export async function downloadDocument(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'GET');
    const a = await authenticate(request, deps);
    if (!a.ok) return a.response;

    const url = new URL(request.url);
    const filingId = url.searchParams.get('filing') ?? '';
    const kind = url.searchParams.get('kind') ?? '';
    if (!UUID_RE.test(filingId) || !DOCUMENT_KINDS.has(kind as DocumentKind)) {
      throw new HttpError(400, 'invalid_input', 'A valid document is required.');
    }

    let allowed: boolean;
    try {
      const rule = LIMITS.download.perUser;
      allowed = await deps.throttle.hit(bucketKey(deps.config.throttleSecret, 'dl-user', a.user.id), rule.limit, rule.windowSeconds);
    } catch {
      throw new HttpError(503, 'unavailable', 'We could not complete that right now. Please try again shortly.');
    }
    if (!allowed) {
      return errorResponse(429, 'rate_limited', 'Too many downloads. Please wait a few minutes and try again.', {
        headers: { 'Retry-After': String(LIMITS.download.perUser.windowSeconds) },
      });
    }

    // 1. Authorise through row-level security: if this filing is not visible to the signed-in user, it is a 404.
    const found = await deps.userDb(a.accessToken)
      .from('filings')
      .select('id,tenant_id,connection_id,jurisdiction,period_code,due_on,documents')
      .eq('id', filingId)
      .maybeSingle();
    if (found.error) throw new Error('could not load filing');
    const filing = found.data as Row | null;
    if (!filing || !documentsOf(filing['documents'], filingId, a.user.isStaff).some((d) => d.kind === kind)) throw NOT_FOUND();

    // 2. Only now use the service role (clients cannot read connections), for a row we have already authorised.
    const conn = await deps.serviceDb
      .from('provider_connections')
      .select(CONNECTION_COLUMNS)
      .eq('id', String(filing['connection_id']))
      .maybeSingle();
    if (conn.error || !conn.data) throw new Error('could not load connection');
    const connection = connectionFromRow(conn.data as Row);

    // 3. Record the access BEFORE any data leaves. If it cannot be recorded, nothing is served.
    try {
      await deps.audit.record({
        tenantId: String(filing['tenant_id']),
        actorId: a.user.id,
        action: 'document.download',
        target: `filing:${filingId}:${kind}`,
        detail: { jurisdiction: filing['jurisdiction'], period: filing['period_code'] },
      });
    } catch {
      deps.log('audit.download_not_recorded');
      throw new HttpError(503, 'unavailable', 'We could not complete that right now. Please try again shortly.');
    }

    // 4. Get a fresh link (they expire after an hour, so they are never stored) and stream the file.
    let link;
    try {
      link = await deps.resolveAdapter(connection).getDocumentLink(
        { providerCompanyId: connection.providerCompanyId },
        {
          jurisdiction: String(filing['jurisdiction']),
          periodCode: String(filing['period_code']),
          dueOn: String(filing['due_on']),
          kind: kind as DocumentKind,
        },
      );
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') throw NOT_FOUND();
      deps.log('document.provider_error', { kind: err instanceof ProviderError ? err.kind : 'unexpected' });
      throw UNAVAILABLE_DOC();
    }

    let linkUrl: URL;
    try {
      linkUrl = new URL(link.url);
    } catch {
      throw UNAVAILABLE_DOC();
    }
    if (linkUrl.protocol !== 'https:') {
      deps.log('document.non_https_link');
      throw UNAVAILABLE_DOC();
    }

    let upstream: Response;
    try {
      upstream = await deps.fetchImpl(linkUrl);
    } catch {
      deps.log('document.fetch_failed');
      throw UNAVAILABLE_DOC();
    }
    if (!upstream.ok || !upstream.body) {
      deps.log('document.fetch_status', { status: upstream.status });
      throw UNAVAILABLE_DOC();
    }

    // Only a short allow-list of types is passed through; anything else is served as an opaque download,
    // so a hostile or mislabelled file can never be rendered as a web page.
    const declared = (upstream.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const ext = SAFE_TYPES[declared];
    const filename = `${String(filing['jurisdiction'])}-${String(filing['period_code'])}-${kind}${ext ?? '.bin'}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const headers = new Headers({
      'Content-Type': ext ? declared : 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const length = upstream.headers.get('content-length');
    if (length && /^\d+$/.test(length)) headers.set('Content-Length', length);
    for (const c of a.setCookies) headers.append('Set-Cookie', c);
    return new Response(upstream.body, { status: 200, headers });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
