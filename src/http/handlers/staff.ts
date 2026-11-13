import { ProviderError } from '../../core/errors.ts';
import { SecretBoxError, encryptSecret } from '../../core/secretbox.ts';
import type { ProductKey, ProviderConnection } from '../../core/types.ts';
import { isKnownProvider, knownProviders } from '../../providers/registry.ts';
import { CONNECTION_COLUMNS, connectionFromRow } from '../../sync/supabaseSource.ts';
import { syncAll, type SyncResult } from '../../sync/sync.ts';
import type { ConnectionSource } from '../../sync/runner.ts';
import type { SyncStore } from '../../sync/sync.ts';
import { LIMITS } from '../limits.ts';
import { authenticate, type Authenticated } from '../session.ts';
import type { Deps } from '../types.ts';
import { MAX_LOGO_BYTES, sniffImageType } from './logo.ts';
import { HttpError, UUID_RE, bucketKey, errorResponse, jsonResponse, normalizeEmail, readJsonObject, requireAllowedOrigin, requireMethod, toErrorResponse } from '../util.ts';

/**
 * Staff-only endpoints: list clients, add a client (with their own provider token), and refresh one client now.
 *
 * Every handler here (1) requires a signed-in user whose account carries the staff flag, and (2) answers anyone else
 * with the same plain 404 as an unknown address, so the existence of these endpoints is not advertised to clients.
 * Provider tokens are accepted here, encrypted straight away, and never returned, logged or audited.
 */

/** What staff-only handlers need beyond the normal Deps: somewhere to read connections and record sync runs. */
export interface StaffDeps {
  source: Pick<ConnectionSource, 'getActive'>;
  store: SyncStore;
}

const PRODUCTS = new Set<ProductKey>(['us_sales_tax', 'eu_vat']);
const NOT_FOUND = () => new HttpError(404, 'not_found', 'Not found.');
type Row = Record<string, unknown>;

async function requireStaff(request: Request, deps: Deps): Promise<Extract<Authenticated, { ok: true }> | Response> {
  const a = await authenticate(request, deps);
  if (!a.ok) return a.response;
  if (!a.user.isStaff) return errorResponse(404, 'not_found', 'Not found.', { setCookies: a.setCookies });
  return a;
}

async function throttleStaff(deps: Deps, userId: string): Promise<void> {
  const rule = LIMITS.staffWrite.perUser;
  let allowed: boolean;
  try {
    allowed = await deps.throttle.hit(bucketKey(deps.config.throttleSecret, 'staff-write', userId), rule.limit, rule.windowSeconds);
  } catch {
    throw new HttpError(503, 'unavailable', 'We could not complete that right now. Please try again shortly.');
  }
  if (!allowed) throw new HttpError(429, 'rate_limited', 'Too many changes in a short time. Please wait a while and try again.');
}

/** GET /api/staff?op=clients: every client with their connections' health. Never includes tokens or credential names. */
export async function listClients(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'GET');
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;

    const [t, c, m, lg] = await Promise.all([
      deps.serviceDb.from('tenants').select('id,name,created_at').order('name', { ascending: true }),
      deps.serviceDb
        .from('provider_connections')
        .select('id,tenant_id,product,provider_key,status,last_synced_at,last_sync_status,last_sync_error'),
      deps.serviceDb.from('tenant_members').select('tenant_id,user_id'),
      deps.serviceDb.from('tenant_logos').select('tenant_id'),
    ]);
    if (t.error || c.error || m.error || lg.error) throw new Error('could not load clients');
    const withLogo = new Set(((lg.data ?? []) as Row[]).map((r) => String(r['tenant_id'])));

    const connections = (c.data ?? []) as Row[];
    const members = (m.data ?? []) as Row[];
    return jsonResponse(
      {
        // Display names for the staff screen. Kept here (not in the static page) so clients' browsers never receive them.
        providers: knownProviders().map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1) })),
        clients: ((t.data ?? []) as Row[]).map((tenant) => ({
          id: tenant['id'],
          name: tenant['name'],
          createdAt: tenant['created_at'] ?? null,
          users: members.filter((x) => x['tenant_id'] === tenant['id']).length,
          hasLogo: withLogo.has(String(tenant['id'])),
          connections: connections
            .filter((x) => x['tenant_id'] === tenant['id'])
            .map((x) => ({
              id: x['id'],
              product: x['product'],
              provider: x['provider_key'],
              status: x['status'],
              lastSyncedAt: x['last_synced_at'] ?? null,
              lastSyncStatus: x['last_sync_status'] ?? null,
              lastSyncError: x['last_sync_error'] ?? null,
            })),
        })),
      },
      200,
      { setCookies: s.setCookies },
    );
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 120) throw new HttpError(400, 'invalid_input', "Enter the client's name (2 to 120 characters).");
  return name;
}

function cleanToken(v: unknown): string {
  const token = typeof v === 'string' ? v.trim() : '';
  if (token.length < 10 || token.length > 600 || /\s/.test(token)) {
    throw new HttpError(400, 'invalid_input', 'Paste the full provider token (no spaces).');
  }
  return token;
}

function cleanCompanyId(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const id = typeof v === 'string' ? v.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new HttpError(400, 'invalid_input', "The provider's company ID can only contain letters, numbers, - and _.");
  return id;
}

async function runOneSync(connection: ProviderConnection, deps: Deps, staff: StaffDeps): Promise<SyncResult> {
  const [result] = await syncAll([connection], deps.resolveAdapter, staff.store, { now: deps.now });
  return result!;
}

/** Short, vendor-neutral-for-clients description of a sync outcome, for the staff screen. */
function syncSummary(r: SyncResult): { status: SyncResult['status']; registrations: number; filings: number; error: string | null } {
  return { status: r.status, registrations: r.registrations, filings: r.filings, error: r.error };
}

/**
 * POST /api/staff?op=create-client
 *   { name, product, provider, token, providerCompanyId?, email? }
 *
 * 1. checks the token works BEFORE anything is saved,
 * 2. creates the client and its connection (token saved encrypted),
 * 3. optionally creates the first user's invite-only sign-in and makes them the client's owner,
 * 4. runs a first refresh so the client's data is there straight away.
 * If saving the connection fails, the half-made client is removed again.
 */
export async function createClient(request: Request, deps: Deps, staff: StaffDeps): Promise<Response> {
  try {
    requireMethod(request, 'POST');
    requireAllowedOrigin(request, deps.config);
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    await throttleStaff(deps, s.user.id);

    const body = await readJsonObject(request, 8192);
    const name = cleanName(body['name']);
    const product = String(body['product'] ?? '') as ProductKey;
    const provider = String(body['provider'] ?? '');
    if (!PRODUCTS.has(product)) throw new HttpError(400, 'invalid_input', 'Choose a service.');
    if (!isKnownProvider(provider)) throw new HttpError(400, 'invalid_input', 'That provider is not set up in the portal yet.');
    const token = cleanToken(body['token']);
    const providerCompanyId = cleanCompanyId(body['providerCompanyId']);
    const email = body['email'] === undefined || body['email'] === '' ? null : normalizeEmail(body['email']);

    let enc: string;
    try {
      enc = encryptSecret(token, deps.credentialKey);
    } catch (err) {
      if (err instanceof SecretBoxError) {
        deps.log('staff.encryption_not_configured');
        throw new HttpError(503, 'encryption_not_configured', 'Token storage is not set up yet (CREDENTIAL_ENCRYPTION_KEY is missing or invalid on the server).');
      }
      throw err;
    }

    // 1. Prove the token works, using exactly the path the daily sync will use (so decryption is proven too).
    const draft: ProviderConnection = {
      id: 'draft', tenantId: 'draft', product, providerKey: provider, providerCompanyId, credentialRef: null, credentialEnc: enc, status: 'active',
    };
    try {
      await deps.resolveAdapter(draft).healthCheck({ providerCompanyId });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') throw new HttpError(400, 'token_rejected', 'The provider did not accept that token. Check it was copied in full, and that it belongs to this client.');
      if (err instanceof ProviderError && err.kind === 'config') throw new HttpError(503, 'unavailable', 'The portal could not use that token. Check the server settings.');
      deps.log('staff.token_check_failed', { kind: err instanceof ProviderError ? err.kind : 'unexpected' });
      throw new HttpError(502, 'provider_unavailable', 'Could not reach the provider to check the token. Please try again shortly.');
    }

    // 2. Save the client and its connection.
    const tenant = await deps.serviceDb.from('tenants').insert({ name }).select('id').single();
    const tenantId = (tenant.data as Row | null)?.['id'];
    if (tenant.error || typeof tenantId !== 'string') throw new Error('could not create client');

    const conn = await deps.serviceDb
      .from('provider_connections')
      .insert({ tenant_id: tenantId, product, provider_key: provider, provider_company_id: providerCompanyId, credential_enc: enc, status: 'active' })
      .select(CONNECTION_COLUMNS)
      .single();
    if (conn.error || !conn.data) {
      await deps.serviceDb.from('tenants').delete().eq('id', tenantId); // undo the half-made client
      throw new Error('could not save connection');
    }
    const connection = connectionFromRow(conn.data as Row);

    // 3. First user (optional, and never allowed to undo the client if it fails).
    let invite: 'created' | 'existing' | 'failed' | null = null;
    if (email) {
      const u = await deps.auth.ensureUser(email);
      if (u) {
        const link = await deps.serviceDb.from('tenant_members').insert({ tenant_id: tenantId, user_id: u.id, role: 'owner' });
        invite = link.error ? 'failed' : u.created ? 'created' : 'existing';
      } else {
        invite = 'failed';
      }
    }

    // The token never goes in the audit trail.
    try {
      await deps.audit.record({
        tenantId,
        actorId: s.user.id,
        action: 'staff.client_created',
        target: `tenant:${tenantId}`,
        detail: { product, provider, invited: invite },
      });
    } catch {
      deps.log('audit.staff_not_recorded');
    }

    // 4. First refresh. A failure here does not undo anything: the client exists and the daily sync will retry.
    let sync: ReturnType<typeof syncSummary>;
    try {
      sync = syncSummary(await runOneSync(connection, deps, staff));
    } catch {
      sync = { status: 'failed', registrations: 0, filings: 0, error: 'first refresh could not run' };
    }

    return jsonResponse({ client: { id: tenantId, name }, connectionId: connection.id, invite, sync }, 201, { setCookies: s.setCookies });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

/** POST /api/staff?op=sync  { connectionId }: refresh one client's data now instead of waiting for the daily run. */
export async function syncNow(request: Request, deps: Deps, staff: StaffDeps): Promise<Response> {
  try {
    requireMethod(request, 'POST');
    requireAllowedOrigin(request, deps.config);
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    await throttleStaff(deps, s.user.id);

    const body = await readJsonObject(request);
    const id = String(body['connectionId'] ?? '');
    if (!UUID_RE.test(id)) throw new HttpError(400, 'invalid_input', 'A valid connection is required.');
    const connection = await staff.source.getActive(id);
    if (!connection) throw NOT_FOUND();

    const result = await runOneSync(connection, deps, staff);
    return jsonResponse({ sync: syncSummary(result) }, 200, { setCookies: s.setCookies });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

const ROLES = new Set(['owner', 'member', 'accountant']);

/** GET /api/staff?op=users&tenant=<id>: who has access to one client (emails and roles). */
export async function listUsers(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'GET');
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    const tenant = new URL(request.url).searchParams.get('tenant') ?? '';
    if (!UUID_RE.test(tenant)) throw new HttpError(400, 'invalid_input', 'A valid client is required.');
    const { data, error } = await deps.serviceDb.rpc('tenant_member_list', { p_tenant: tenant });
    if (error) throw new Error('could not load users');
    return jsonResponse(
      { users: ((data ?? []) as Row[]).map((u) => ({ userId: u['user_id'], email: u['email'], role: u['role'] })) },
      200,
      { setCookies: s.setCookies },
    );
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

async function tenantExists(deps: Deps, tenantId: string): Promise<void> {
  const t = await deps.serviceDb.from('tenants').select('id').eq('id', tenantId).maybeSingle();
  if (t.error) throw new Error('could not load client');
  if (!t.data) throw NOT_FOUND();
}

/** POST /api/staff?op=add-user  { tenantId, email, role }: give a person access to a client (creates their invite-only sign-in if needed). */
export async function addUser(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'POST');
    requireAllowedOrigin(request, deps.config);
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    await throttleStaff(deps, s.user.id);

    const body = await readJsonObject(request);
    const tenantId = String(body['tenantId'] ?? '');
    const role = String(body['role'] ?? '');
    if (!UUID_RE.test(tenantId)) throw new HttpError(400, 'invalid_input', 'A valid client is required.');
    if (!ROLES.has(role)) throw new HttpError(400, 'invalid_input', 'Choose a role.');
    const email = normalizeEmail(body['email']);
    await tenantExists(deps, tenantId);

    const u = await deps.auth.ensureUser(email);
    if (!u) throw new HttpError(502, 'invite_failed', 'The sign-in for that email could not be set up. Please try again shortly.');
    const already = await deps.serviceDb.from('tenant_members').select('user_id').eq('tenant_id', tenantId).eq('user_id', u.id).maybeSingle();
    if (already.error) throw new Error('could not check access');
    if (already.data) throw new HttpError(409, 'already_member', 'That person already has access to this client.');
    const link = await deps.serviceDb.from('tenant_members').insert({ tenant_id: tenantId, user_id: u.id, role });
    if (link.error) throw new Error('could not add user');

    try {
      await deps.audit.record({ tenantId, actorId: s.user.id, action: 'staff.user_added', target: `user:${u.id}`, detail: { role, newSignIn: u.created } });
    } catch {
      deps.log('audit.staff_not_recorded');
    }
    return jsonResponse({ ok: true, newSignIn: u.created }, 201, { setCookies: s.setCookies });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

/** POST /api/staff?op=remove-user  { tenantId, userId }: take a person's access to a client away. Their sign-in itself is kept. */
export async function removeUser(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'POST');
    requireAllowedOrigin(request, deps.config);
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    await throttleStaff(deps, s.user.id);

    const body = await readJsonObject(request);
    const tenantId = String(body['tenantId'] ?? '');
    const userId = String(body['userId'] ?? '');
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(userId)) throw new HttpError(400, 'invalid_input', 'A valid client and person are required.');
    const del = await deps.serviceDb.from('tenant_members').delete().eq('tenant_id', tenantId).eq('user_id', userId);
    if (del.error) throw new Error('could not remove user');
    try {
      await deps.audit.record({ tenantId, actorId: s.user.id, action: 'staff.user_removed', target: `user:${userId}` });
    } catch {
      deps.log('audit.staff_not_recorded');
    }
    return jsonResponse({ ok: true }, 200, { setCookies: s.setCookies });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

/**
 * POST /api/staff?op=logo  { tenantId, data }  (data = the image as base64)   or   { tenantId, remove: true }
 * PNG, JPEG or WebP, up to 150 KB, judged by the file's real contents.
 */
export async function setLogo(request: Request, deps: Deps): Promise<Response> {
  try {
    requireMethod(request, 'POST');
    requireAllowedOrigin(request, deps.config);
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    await throttleStaff(deps, s.user.id);

    const body = await readJsonObject(request, 260_000);
    const tenantId = String(body['tenantId'] ?? '');
    if (!UUID_RE.test(tenantId)) throw new HttpError(400, 'invalid_input', 'A valid client is required.');
    await tenantExists(deps, tenantId);

    if (body['remove'] === true) {
      const del = await deps.serviceDb.from('tenant_logos').delete().eq('tenant_id', tenantId);
      if (del.error) throw new Error('could not remove logo');
      await deps.audit.record({ tenantId, actorId: s.user.id, action: 'staff.logo_removed', target: `tenant:${tenantId}` }).catch(() => deps.log('audit.staff_not_recorded'));
      return jsonResponse({ ok: true, hasLogo: false }, 200, { setCookies: s.setCookies });
    }

    const raw = typeof body['data'] === 'string' ? body['data'] : '';
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new HttpError(400, 'invalid_input', 'Choose a PNG, JPEG or WebP image.');
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length > MAX_LOGO_BYTES) throw new HttpError(400, 'too_large', 'That image is too large. Please use one under 150 KB.');
    const type = sniffImageType(bytes);
    if (!type) throw new HttpError(400, 'invalid_input', 'Choose a PNG, JPEG or WebP image.');

    const save = await deps.serviceDb.from('tenant_logos').upsert({ tenant_id: tenantId, content_type: type, data_b64: bytes.toString('base64'), updated_at: deps.now().toISOString() });
    if (save.error) throw new Error('could not save logo');
    await deps.audit.record({ tenantId, actorId: s.user.id, action: 'staff.logo_set', target: `tenant:${tenantId}`, detail: { type, bytes: bytes.length } }).catch(() => deps.log('audit.staff_not_recorded'));
    return jsonResponse({ ok: true, hasLogo: true }, 200, { setCookies: s.setCookies });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
