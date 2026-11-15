import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

/** A small in-memory stand-in for the database and file storage, enough for the VAT handlers. */
export function vatDb(tables: Record<string, Row[]>, visible: ReadonlySet<string> | null, files: Map<string, Uint8Array>) {
  class Q implements PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> {
    private filters: ((r: Row) => boolean)[] = [];
    private orders: { col: string; asc: boolean }[] = [];
    private cap = Infinity;
    private cols: string | null = null;
    private one = false;
    private mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
    private patch: Row = {};
    private rows: Row[] = [];
    private t: string;
    constructor(t: string) { this.t = t; }
    select(c = '*') { this.cols = c; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
    in(c: string, v: unknown[]) { this.filters.push((r) => v.includes(r[c])); return this; }
    order(c: string, o: { ascending?: boolean } = {}) { this.orders.push({ col: c, asc: o.ascending !== false }); return this; }
    limit(n: number) { this.cap = n; return this; }
    maybeSingle() { this.one = true; return this; }
    single() { this.one = true; return this; }
    insert(v: Row | Row[]) { this.mode = 'insert'; this.rows = (Array.isArray(v) ? v : [v]).map((x) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...x })); return this; }
    update(p: Row) { this.mode = 'update'; this.patch = p; return this; }
    delete() { this.mode = 'delete'; return this; }
    private run() {
      const list = (tables[this.t] ??= []);
      if (this.mode === 'insert') {
        const uniq: Record<string, string[]> = { vat_returns: ['tenant_id', 'scheme', 'country', 'period_code'], vat_registrations: ['tenant_id', 'scheme', 'country'] };
        for (const r of this.rows) {
          const k = uniq[this.t];
          if (k && list.some((x) => k.every((c) => x[c] === r[c]))) return { data: null, error: { message: 'duplicate', code: '23505' } };
        }
        list.push(...this.rows);
        return { data: this.one ? this.rows[0] ?? null : this.rows, error: null };
      }
      let rows = list.filter((r) => this.filters.every((f) => f(r)));
      if (visible) rows = rows.filter((r) => (this.t === 'tenants' ? visible.has(String(r['id'])) : !('tenant_id' in r) || visible.has(String(r['tenant_id']))));
      if (this.mode === 'update') { for (const r of rows) Object.assign(r, this.patch); return { data: null, error: null }; }
      if (this.mode === 'delete') { tables[this.t] = list.filter((r) => !rows.includes(r)); return { data: null, error: null }; }
      for (const { col, asc } of [...this.orders].reverse()) rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      rows = rows.slice(0, this.cap);
      if (this.cols && this.cols !== '*') { const c = this.cols.split(',').map((x) => x.trim()); rows = rows.map((r) => Object.fromEntries(c.map((k) => [k, r[k]]))); }
      return { data: this.one ? rows[0] ?? null : rows, error: null };
    }
    then<A, B>(ok?: ((v: { data: unknown; error: { message: string; code?: string } | null }) => A | PromiseLike<A>) | null, err?: ((e: unknown) => B | PromiseLike<B>) | null) { return Promise.resolve(this.run()).then(ok, err); }
  }
  const storage = {
    from: () => ({
      upload: async (path: string, bytes: Uint8Array) => { if (files.has(path)) return { error: { message: 'exists' } }; files.set(path, bytes); return { error: null }; },
      remove: async (paths: string[]) => { for (const p of paths) files.delete(p); return { error: null }; },
      createSignedUrl: async (path: string, _s: number, o: { download?: string }) => (files.has(path) ? { data: { signedUrl: `https://files.test/${path}?download=${o.download ?? ''}&token=abc` }, error: null } : { data: null, error: { message: 'missing' } }),
    }),
    createBucket: async () => ({ error: null }),
  };
  return { from: (t: string) => new Q(t), storage } as unknown as SupabaseClient;
}
