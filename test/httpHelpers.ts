import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MockAdapter } from '../src/providers/mock/adapter.ts';
import type { ProviderAdapter, ProviderConnection } from '../src/core/types.ts';
import type { AuditEntry, AuditSink } from '../src/http/audit.ts';
import type {
  AuthApi,
  AuthUser,
  SendCodeResult,
  SessionTokens,
  TokenResult,
  UserResult,
} from '../src/http/authApi.ts';
import { loadConfig, type AppConfig } from '../src/http/config.ts';
import type { Throttle } from '../src/http/throttle.ts';
import type { Deps } from '../src/http/types.ts';
import { canonFiling } from './helpers.ts';

type Row = Record<string, unknown>;

// ------------------------------------------------------------------ identifiers

export const T_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const T_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
export const U_A = 'a1111111-0000-4000-8000-000000000001';
export const U_B = 'b2222222-0000-4000-8000-000000000002';
export const U_STAFF = 'c3333333-0000-4000-8000-000000000003';
export const C_A_US = 'ca000000-0000-4000-8000-000000000001';
export const C_A_OLD = 'ca000000-0000-4000-8000-000000000009';
export const C_A_VAT = 'ca000000-0000-4000-8000-000000000002';
export const C_B_US = 'cb000000-0000-4000-8000-000000000001';
export const F_A_JAN = 'f1000000-0000-4000-8000-000000000001';
export const F_A_FEB = 'f1000000-0000-4000-8000-000000000002';
export const F_A_OLD = 'f1000000-0000-4000-8000-000000000003';
export const F_B_JAN = 'f2000000-0000-4000-8000-000000000001';

export const TEST_ENV = {
  APP_ORIGIN: 'https://portal.example.com',
  AUTH_THROTTLE_SECRET: 'throttle-secret-'.padEnd(48, 'x'),
  CRON_SECRET: 'cron-secret-'.padEnd(48, 'y'),
};
export const ORIGIN = TEST_ENV.APP_ORIGIN;

export function testConfig(over: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ ...TEST_ENV, ...over });
}

// ------------------------------------------------------------------ fake sign-in service

let tokenSeq = 0;

export class FakeAuth implements AuthApi {
  sendResult: SendCodeResult = 'sent';
  down = false;
  /** email -> the code that will be accepted for it */
  codes = new Map<string, string>();
  users = new Map<string, AuthUser>();
  validAccess = new Map<string, AuthUser>();
  validRefresh = new Map<string, AuthUser>();
  calls = {
    send: [] as string[],
    verify: [] as { email: string; code: string }[],
    refresh: [] as string[],
    getUser: [] as string[],
    revoke: [] as string[],
  };

  addUser(user: AuthUser, code = '123456'): void {
    this.users.set(user.email, user);
    this.codes.set(user.email, code);
  }

  /** Issue a working session (as if the person had just signed in). */
  session(user: AuthUser): SessionTokens {
    tokenSeq += 1;
    const tokens = { accessToken: `access-${tokenSeq}.jwt`, refreshToken: `refresh-${tokenSeq}`, expiresIn: 3600 };
    this.validAccess.set(tokens.accessToken, user);
    this.validRefresh.set(tokens.refreshToken, user);
    return tokens;
  }

  async sendCode(email: string): Promise<SendCodeResult> {
    this.calls.send.push(email);
    return this.down ? 'unavailable' : this.sendResult;
  }

  async verifyCode(email: string, code: string): Promise<TokenResult> {
    this.calls.verify.push({ email, code });
    if (this.down) return { ok: false, reason: 'unavailable' };
    const user = this.users.get(email);
    if (!user || this.codes.get(email) !== code) return { ok: false, reason: 'invalid' };
    return { ok: true, tokens: this.session(user), user };
  }

  async refresh(refreshToken: string): Promise<TokenResult> {
    this.calls.refresh.push(refreshToken);
    if (this.down) return { ok: false, reason: 'unavailable' };
    const user = this.validRefresh.get(refreshToken);
    if (!user) return { ok: false, reason: 'invalid' };
    this.validRefresh.delete(refreshToken); // refresh tokens rotate
    return { ok: true, tokens: this.session(user), user };
  }

  async getUser(accessToken: string): Promise<UserResult> {
    this.calls.getUser.push(accessToken);
    if (this.down) return { ok: false, reason: 'unavailable' };
    const user = this.validAccess.get(accessToken);
    return user ? { ok: true, user } : { ok: false, reason: 'invalid' };
  }

  async revoke(accessToken: string): Promise<void> {
    this.calls.revoke.push(accessToken);
    this.validAccess.delete(accessToken);
  }

  ensureFails = false;
  ensured: string[] = [];
  async ensureUser(email: string): Promise<{ id: string; created: boolean } | null> {
    this.ensured.push(email);
    if (this.ensureFails) return null;
    const existing = this.users.get(email);
    if (existing) return { id: existing.id, created: false };
    const id = randomUUID();
    this.users.set(email, { id, email, isStaff: false });
    return { id, created: true };
  }
}

// ------------------------------------------------------------------ fake throttle & audit

export class InMemoryThrottle implements Throttle {
  hits = new Map<string, number[]>();
  failing = false;
  clock = () => Date.now();

  async hit(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    if (this.failing) throw new Error('throttle store down');
    const now = this.clock();
    const live = (this.hits.get(bucket) ?? []).filter((t) => t > now - windowSeconds * 1000);
    if (live.length >= limit) {
      this.hits.set(bucket, live);
      return false; // blocked attempts are not recorded
    }
    live.push(now);
    this.hits.set(bucket, live);
    return true;
  }

  async reset(bucket: string): Promise<void> {
    if (this.failing) throw new Error('throttle store down');
    this.hits.delete(bucket);
  }
}

export class RecordingAudit implements AuditSink {
  entries: AuditEntry[] = [];
  failing = false;
  async record(entry: AuditEntry): Promise<void> {
    if (this.failing) throw new Error('audit store down');
    this.entries.push(entry);
  }
}

// ------------------------------------------------------------------ fake database with row-level-security simulation

export interface FakeDb {
  client: SupabaseClient;
  /** Every select(): which table, which columns, in order. Used to cross-check against the real schema. */
  selections: { table: string; columns: string }[];
  /** Tables touched at all. */
  touched: string[];
  /** Every column used in a filter or ordering, so tests can cross-check names against the real schema. */
  columnRefs: { table: string; column: string }[];
  /** Inserts and deletes made through this client (rows as written). */
  writes: { op: 'insert' | 'delete'; table: string; rows: Row[] }[];
  /** Make the next insert into this table fail (to test clean-up). */
  failNextInsert(table: string): void;
}

/**
 * `visibleTenants`: a Set simulates a signed-in client (row-level security: only rows of those tenants);
 * null simulates the service role (sees everything). The real policies are verified separately in SQL.
 */
export function fakeDb(tables: Record<string, Row[]>, visibleTenants: ReadonlySet<string> | null, emails: Map<string, string> = new Map()): FakeDb {
  const selections: FakeDb['selections'] = [];
  const touched: string[] = [];
  const columnRefs: FakeDb['columnRefs'] = [];
  const writes: FakeDb['writes'] = [];
  const failures = new Map<string, number>();

  class Query implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
    private readonly table: string;
    private columns: string | null = null;
    private filters: ((r: Row) => boolean)[] = [];
    private orders: { col: string; asc: boolean }[] = [];
    private window: [number, number] | null = null;
    private one = false;
    private mode: 'select' | 'insert' | 'delete' = 'select';
    private inserted: Row[] = [];
    private failInsert = false;

    constructor(table: string) {
      this.table = table;
    }
    select(columns = '*'): this {
      this.columns = columns;
      selections.push({ table: this.table, columns });
      return this;
    }
    eq(col: string, value: unknown): this {
      columnRefs.push({ table: this.table, column: col });
      this.filters.push((r) => r[col] === value);
      return this;
    }
    in(col: string, values: unknown[]): this {
      columnRefs.push({ table: this.table, column: col });
      this.filters.push((r) => values.includes(r[col]));
      return this;
    }
    order(col: string, opts: { ascending?: boolean } = {}): this {
      columnRefs.push({ table: this.table, column: col });
      this.orders.push({ col, asc: opts.ascending !== false });
      return this;
    }
    range(from: number, to: number): this {
      this.window = [from, to];
      return this;
    }
    maybeSingle(): this {
      this.one = true;
      return this;
    }
    single(): this {
      this.one = true;
      return this;
    }
    insert(values: Row | Row[]): this {
      this.mode = 'insert';
      const list = Array.isArray(values) ? values : [values];
      this.failInsert = (failures.get(this.table) ?? 0) > 0;
      if (this.failInsert) failures.set(this.table, (failures.get(this.table) ?? 1) - 1);
      else {
        this.inserted = list.map((v) => ({ ...(this.table === 'tenants' || this.table === 'provider_connections' ? { id: randomUUID() } : {}), ...v }));
        (tables[this.table] ??= []).push(...this.inserted);
        writes.push({ op: 'insert', table: this.table, rows: this.inserted.map((r) => ({ ...r })) });
      }
      return this;
    }
    delete(): this {
      this.mode = 'delete';
      return this;
    }
    upsert(values: Row): this {
      // One row per tenant_id (the only table that is upserted): replace what is there.
      tables[this.table] = (tables[this.table] ?? []).filter((r) => r['tenant_id'] !== values['tenant_id']);
      return this.insert(values);
    }
    private run(): { data: unknown; error: { message: string } | null } {
      touched.push(this.table);
      if (this.mode === 'insert') {
        if (this.failInsert) return { data: null, error: { message: 'insert failed' } };
        const out = this.columns && this.columns !== '*' ? this.inserted.map((r) => Object.fromEntries(this.columns!.split(',').map((c) => [c.trim(), r[c.trim()]]))) : this.inserted;
        return { data: this.one ? (out[0] ?? null) : out, error: null };
      }
      let rows = [...(tables[this.table] ?? [])];
      if (this.mode === 'delete') {
        for (const f of this.filters) rows = rows.filter(f);
        tables[this.table] = (tables[this.table] ?? []).filter((r) => !rows.includes(r));
        writes.push({ op: 'delete', table: this.table, rows });
        return { data: null, error: null };
      }
      if (visibleTenants) {
        rows = rows.filter((r) => {
          if (this.table === 'tenants') return visibleTenants.has(String(r['id']));
          return !('tenant_id' in r) || visibleTenants.has(String(r['tenant_id']));
        });
      }
      for (const f of this.filters) rows = rows.filter(f);
      for (const { col, asc } of [...this.orders].reverse()) {
        rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.window) rows = rows.slice(this.window[0], this.window[1] + 1);
      if (this.columns && this.columns !== '*') {
        const cols = this.columns.split(',').map((c) => c.trim());
        rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      }
      return { data: this.one ? (rows[0] ?? null) : rows, error: null };
    }
    then<A, B>(onOk?: ((v: { data: unknown; error: { message: string } | null }) => A | PromiseLike<A>) | null, onErr?: ((e: unknown) => B | PromiseLike<B>) | null) {
      return Promise.resolve(this.run()).then(onOk, onErr);
    }
  }

  const client = {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Row) => {
      touched.push(`rpc:${name}`);
      if (name === 'tenant_member_list') {
        const rows = (tables['tenant_members'] ?? []).filter((m) => m['tenant_id'] === args['p_tenant']).map((m) => ({ user_id: m['user_id'], email: String(emails.get(String(m['user_id'])) ?? 'unknown@x.test'), role: m['role'] ?? 'member' }));
        return { data: rows, error: null };
      }
      return { data: null, error: { message: 'unknown rpc' } };
    },
  } as unknown as SupabaseClient;
  return { client, selections, touched, columnRefs, writes, failNextInsert: (table: string) => void failures.set(table, 1) };
}

// ------------------------------------------------------------------ one-stop deps builder

export interface Harness {
  deps: Deps;
  auth: FakeAuth;
  throttle: InMemoryThrottle;
  audit: RecordingAudit;
  logs: { event: string; fields?: Record<string, unknown> }[];
  /** Fake databases created so far, for inspecting what was queried. */
  userDbs: FakeDb[];
  serviceDb: FakeDb;
  adapters: Map<string, MockAdapter>;
  fetchCalls: URL[];
  setUpstream(fn: (url: URL) => Response | Error): void;
}

export const USER_A: AuthUser = { id: U_A, email: 'ann@acme.test', isStaff: false };
export const USER_B: AuthUser = { id: U_B, email: 'bob@beta.test', isStaff: false };
export const USER_STAFF: AuthUser = { id: U_STAFF, email: 'sam@taxcart.test', isStaff: true };

export function defaultTables(): Record<string, Row[]> {
  return {
    tenants: [
      { id: T_A, name: 'Acme Skincare' },
      { id: T_B, name: 'Beta Foods' },
    ],
    tenant_members: [
      { tenant_id: T_A, user_id: U_A },
      { tenant_id: T_B, user_id: U_B },
    ],
    tenant_products: [
      { connection_id: C_A_US, tenant_id: T_A, product: 'us_sales_tax', is_active: true, last_synced_at: '2026-10-22T03:00:00Z', last_sync_status: 'succeeded' },
      { connection_id: C_A_OLD, tenant_id: T_A, product: 'us_sales_tax', is_active: false, last_synced_at: '2026-01-01T00:00:00Z', last_sync_status: 'succeeded' },
      { connection_id: C_A_VAT, tenant_id: T_A, product: 'eu_vat', is_active: true, last_synced_at: null, last_sync_status: null },
      { connection_id: C_B_US, tenant_id: T_B, product: 'us_sales_tax', is_active: true, last_synced_at: '2026-10-22T03:00:00Z', last_sync_status: 'failed' },
    ],
    filings: [
      { id: F_A_JAN, tenant_id: T_A, connection_id: C_A_US, jurisdiction: 'KS', period_code: '2025-JAN', period_name: 'January 2025', frequency: 'monthly', raw_frequency_code: 'M', due_on: '2025-02-25', is_completed: true, estimated_tax_due: 25.25, return_confirmation: 'RET-1', payment_confirmation: 'PAY-1', amount_paid: 25.25, documents: [{ kind: 'return' }, { kind: 'payment' }, { kind: 'template' }] },
      { id: F_A_FEB, tenant_id: T_A, connection_id: C_A_US, jurisdiction: 'KS', period_code: '2025-FEB', period_name: 'February 2025', frequency: 'monthly', raw_frequency_code: 'M', due_on: '2025-03-25', is_completed: false, estimated_tax_due: 31.1, return_confirmation: null, payment_confirmation: null, amount_paid: null, documents: [] },
      { id: F_A_OLD, tenant_id: T_A, connection_id: C_A_OLD, jurisdiction: 'TX', period_code: '2024-Q4', period_name: 'Q4 2024', frequency: 'quarterly', raw_frequency_code: 'Q', due_on: '2025-01-20', is_completed: true, estimated_tax_due: 90, return_confirmation: 'OLD-1', payment_confirmation: null, amount_paid: 90, documents: [{ kind: 'return' }] },
      { id: F_B_JAN, tenant_id: T_B, connection_id: C_B_US, jurisdiction: 'CA', period_code: '2025-JAN', period_name: 'January 2025', frequency: 'monthly', raw_frequency_code: 'M', due_on: '2025-02-28', is_completed: true, estimated_tax_due: 500, return_confirmation: 'BETA-RET', payment_confirmation: 'BETA-PAY', amount_paid: 500, documents: [{ kind: 'return' }] },
    ],
    registrations: [
      { tenant_id: T_A, connection_id: C_A_US, jurisdiction: 'KS', tax_id: 'K100', started_at: '2024-01-01', ended_at: null, frequency: 'monthly', raw_frequency_code: 'M' },
      { tenant_id: T_A, connection_id: C_A_US, jurisdiction: 'NY', tax_id: 'N200', started_at: '2024-06-01', ended_at: null, frequency: 'other', raw_frequency_code: 'NYQ' },
      { tenant_id: T_B, connection_id: C_B_US, jurisdiction: 'CA', tax_id: 'C300', started_at: '2023-01-01', ended_at: null, frequency: 'quarterly', raw_frequency_code: 'Q' },
    ],
    provider_connections: [
      { id: C_A_US, tenant_id: T_A, product: 'us_sales_tax', provider_key: 'vendor-x', provider_company_id: 'company-A', credential_ref: 'VENDOR_X_KEY', status: 'active' },
      { id: C_A_OLD, tenant_id: T_A, product: 'us_sales_tax', provider_key: 'vendor-old', provider_company_id: null, credential_ref: 'OLD_KEY', status: 'paused' },
      { id: C_A_VAT, tenant_id: T_A, product: 'eu_vat', provider_key: 'vat-vendor', provider_company_id: null, credential_ref: 'VAT_KEY', status: 'active' },
      { id: C_B_US, tenant_id: T_B, product: 'us_sales_tax', provider_key: 'vendor-x', provider_company_id: 'company-B', credential_ref: 'VENDOR_X_KEY', status: 'active' },
    ],
  };
}

const MEMBERSHIPS: Record<string, string[]> = { [U_A]: [T_A], [U_B]: [T_B] };

export function harness(opts: { configOverride?: Record<string, string | undefined>; tables?: Record<string, Row[]> } = {}): Harness {
  const tables = opts.tables ?? defaultTables();
  const auth = new FakeAuth();
  auth.addUser(USER_A);
  auth.addUser(USER_B);
  auth.addUser(USER_STAFF);
  const throttle = new InMemoryThrottle();
  const audit = new RecordingAudit();
  const logs: Harness['logs'] = [];
  const userDbs: FakeDb[] = [];
  const serviceDb = fakeDb(tables, null, new Map([[U_A, USER_A.email], [U_B, USER_B.email], [U_STAFF, USER_STAFF.email]]));
  const fetchCalls: URL[] = [];
  let upstream: (url: URL) => Response | Error = () =>
    new Response(new Uint8Array([37, 80, 68, 70, 45, 49]), { headers: { 'content-type': 'application/pdf', 'content-length': '6' } });

  // One adapter per provider; each knows the KS 2025-JAN filing so getDocumentLink can succeed.
  const adapters = new Map<string, MockAdapter>();
  for (const key of ['vendor-x', 'vendor-old', 'vat-vendor']) {
    adapters.set(
      key,
      new MockAdapter({
        key,
        filings: [canonFiling({ externalId: 'KS:2025-JAN', jurisdiction: 'KS', periodCode: '2025-JAN', dueOn: '2025-02-25', documents: [{ kind: 'return' }, { kind: 'payment' }] })],
      }),
    );
  }

  const deps: Deps = {
    config: testConfig(opts.configOverride),
    auth,
    throttle,
    audit,
    userDb: (accessToken) => {
      const user = auth.validAccess.get(accessToken);
      const visible = new Set(user ? (user.isStaff ? [T_A, T_B] : (MEMBERSHIPS[user.id] ?? [])) : []);
      const db = fakeDb(tables, visible);
      userDbs.push(db);
      return db.client;
    },
    serviceDb: serviceDb.client,
    resolveAdapter: (c: ProviderConnection): ProviderAdapter => {
      const a = adapters.get(c.providerKey);
      if (!a) throw new Error(`no adapter for ${c.providerKey}`);
      return a;
    },
    fetchImpl: (async (input: URL | string | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      fetchCalls.push(url);
      const out = upstream(url);
      if (out instanceof Error) throw out;
      return out;
    }) as typeof fetch,
    now: () => new Date('2026-10-22T03:00:00.000Z'),
    log: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
  };

  return { deps, auth, throttle, audit, logs, userDbs, serviceDb, adapters, fetchCalls, setUpstream: (fn) => void (upstream = fn) };
}

// ------------------------------------------------------------------ request builders

export function post(path: string, body: unknown, opts: { origin?: string | null; cookie?: string; ip?: string; contentType?: string | null; raw?: string } = {}): Request {
  const headers = new Headers();
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
  if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? 'application/json');
  if (opts.cookie) headers.set('cookie', opts.cookie);
  headers.set('x-real-ip', opts.ip ?? '203.0.113.7');
  return new Request(`https://portal.example.com${path}`, { method: 'POST', headers, body: opts.raw ?? JSON.stringify(body) });
}

export function get(path: string, opts: { cookie?: string; ip?: string } = {}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set('cookie', opts.cookie);
  headers.set('x-real-ip', opts.ip ?? '203.0.113.7');
  return new Request(`https://portal.example.com${path}`, { method: 'GET', headers });
}

/** Turn a response's Set-Cookie headers into the Cookie header a browser would send back. */
export function cookieHeaderFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((c) => !c.endsWith('='))
    .join('; ');
}

export function cookiesFor(tokens: SessionTokens, secure = true): string {
  const p = secure ? '__Host-' : '';
  return `${p}tc_at=${tokens.accessToken}; ${p}tc_rt=${tokens.refreshToken}`;
}

export async function body(res: Response): Promise<Record<string, any>> {
  return JSON.parse(await res.text());
}
