import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/http/buildDeps.ts
import { createClient } from "@supabase/supabase-js";

// src/core/errors.ts
var ProviderError = class extends Error {
  kind;
  provider;
  status;
  /** True when retrying later could plausibly succeed. */
  retryable;
  constructor(kind, provider, message, opts = {}) {
    super(message, opts.cause !== void 0 ? { cause: opts.cause } : void 0);
    this.name = "ProviderError";
    this.kind = kind;
    this.provider = provider;
    this.status = opts.status ?? null;
    this.retryable = kind === "rate_limit" || kind === "upstream";
  }
};

// src/core/secretbox.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
var PREFIX = "v1";
var SecretBoxError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SecretBoxError";
  }
};
function parseKey(raw) {
  if (!raw) throw new SecretBoxError("CREDENTIAL_ENCRYPTION_KEY is not set");
  const trimmed = raw.trim();
  const buf = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (buf.length !== 32) throw new SecretBoxError("CREDENTIAL_ENCRYPTION_KEY must be 32 random bytes (base64 or 64 hex characters)");
  return buf;
}
function encryptSecret(plaintext, rawKey) {
  const key = parseKey(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}
function decryptSecret(stored, rawKey) {
  const key = parseKey(rawKey);
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new SecretBoxError("Stored credential is in an unknown format");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxError("Stored credential could not be decrypted (wrong key or altered data)");
  }
}

// src/providers/zamp/client.ts
var DEFAULT_BASE_URL = "https://api.zamp.com";
var PROVIDER = "zamp";
var ZampClient = class {
  apiKey;
  baseUrl;
  fetchImpl;
  maxRetries;
  sleep;
  timeoutMs;
  constructor(opts) {
    if (!opts.apiKey) throw new ProviderError("config", PROVIDER, "Zamp API key is empty");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 2e4;
  }
  async get(path, query = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== void 0 && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    let lastError = null;
    let retryAfterMs = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(backoffMs(attempt, lastError, retryAfterMs));
      let res;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (cause) {
        lastError = new ProviderError("upstream", PROVIDER, `Network error calling ${path}`, { cause });
        continue;
      }
      if (res.ok) {
        try {
          return await res.json();
        } catch (cause) {
          throw new ProviderError("bad_response", PROVIDER, `Non-JSON response from ${path}`, {
            status: res.status,
            cause
          });
        }
      }
      const err = await this.errorFor(res, path);
      if (!err.retryable) throw err;
      lastError = err;
      retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    }
    throw lastError ?? new ProviderError("upstream", PROVIDER, `Request to ${path} failed`);
  }
  async errorFor(res, path) {
    let excerpt = "";
    try {
      excerpt = (await res.text()).slice(0, 200);
    } catch {
    }
    const detail = excerpt ? `: ${excerpt}` : "";
    const status = res.status;
    if (status === 401 || status === 403) {
      return new ProviderError("auth", PROVIDER, `Zamp rejected the credential (${status}) on ${path}${detail}`, { status });
    }
    if (status === 404) return new ProviderError("not_found", PROVIDER, `Not found: ${path}${detail}`, { status });
    if (status === 429) return new ProviderError("rate_limit", PROVIDER, `Rate limited on ${path}`, { status });
    if (status >= 500) return new ProviderError("upstream", PROVIDER, `Zamp error ${status} on ${path}${detail}`, { status });
    return new ProviderError("bad_request", PROVIDER, `Zamp rejected the request (${status}) on ${path}${detail}`, { status });
  }
};
function backoffMs(attempt, last, retryAfterMs) {
  if (last?.kind === "rate_limit" && retryAfterMs !== null) return Math.min(retryAfterMs, 3e4);
  return Math.min(500 * 2 ** (attempt - 1), 8e3);
}
function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1e3 : null;
}

// src/core/shape.ts
var Shape = class {
  provider;
  constructor(provider) {
    this.provider = provider;
  }
  fail(where, problem) {
    throw new ProviderError("bad_response", this.provider, `Unexpected response at ${where}: ${problem}`);
  }
  record(v, where) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) this.fail(where, "expected an object");
    return v;
  }
  array(v, where) {
    if (!Array.isArray(v)) this.fail(where, "expected an array");
    return v;
  }
  string(o, key, where) {
    const v = o[key];
    if (typeof v !== "string" || v.length === 0) this.fail(`${where}.${key}`, "expected a non-empty string");
    return v;
  }
  optString(o, key, where) {
    const v = o[key];
    if (v === void 0 || v === null) return null;
    if (typeof v !== "string") this.fail(`${where}.${key}`, "expected a string or null");
    return v;
  }
  boolean(o, key, where) {
    const v = o[key];
    if (typeof v !== "boolean") this.fail(`${where}.${key}`, "expected a boolean");
    return v;
  }
  optNumber(o, key, where) {
    const v = o[key];
    if (v === void 0 || v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v)) this.fail(`${where}.${key}`, "expected a finite number or null");
    return v;
  }
  /** An ISO calendar date (YYYY-MM-DD). A full timestamp is accepted and trimmed to its date. */
  date(o, key, where) {
    const v = this.string(o, key, where);
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    if (!m) this.fail(`${where}.${key}`, "expected an ISO date");
    return m[1];
  }
  optDate(o, key, where) {
    const v = o[key];
    if (v === void 0 || v === null) return null;
    return this.date(o, key, where);
  }
};

// src/providers/zamp/mapper.ts
var shape = new Shape("zamp");
function parseRegistrations(body) {
  return shape.array(body, "registrations").map((item, i) => {
    const where = `registrations[${i}]`;
    const o = shape.record(item, where);
    const reg = shape.record(o["registration"], `${where}.registration`);
    const freqs = o["frequencies"] === void 0 || o["frequencies"] === null ? [] : shape.array(o["frequencies"], `${where}.frequencies`);
    return {
      state: shape.string(o, "state", where),
      taxId: shape.optString(reg, "taxId", `${where}.registration`),
      startedAt: shape.date(reg, "startedAt", `${where}.registration`),
      endedAt: shape.optDate(reg, "endedAt", `${where}.registration`),
      frequencies: freqs.map((f, j) => {
        const fw = `${where}.frequencies[${j}]`;
        const fo = shape.record(f, fw);
        return {
          code: shape.string(fo, "code", fw),
          startedAt: shape.date(fo, "startedAt", fw),
          endedAt: shape.optDate(fo, "endedAt", fw)
        };
      })
    };
  });
}
function parseFilingsPage(body) {
  const root = shape.record(body, "filings response");
  const data = shape.array(root["data"], "filings.data");
  const nextCursor = shape.optString(root, "nextCursor", "filings");
  const filings = data.map((item, i) => {
    const where = `filings.data[${i}]`;
    const o = shape.record(item, where);
    const period = shape.record(o["period"], `${where}.period`);
    const freq = o["frequency"] === void 0 || o["frequency"] === null ? null : shape.record(o["frequency"], `${where}.frequency`);
    const artifacts = o["artifacts"] === void 0 || o["artifacts"] === null ? [] : shape.array(o["artifacts"], `${where}.artifacts`);
    return {
      state: shape.string(o, "state", where),
      periodCode: shape.string(period, "code", `${where}.period`),
      periodName: shape.string(period, "name", `${where}.period`),
      frequencyCode: freq ? shape.optString(freq, "code", `${where}.frequency`) : null,
      dueOn: shape.date(o, "dueOn", where),
      isCompleted: shape.boolean(o, "isCompleted", where),
      estimatedTaxDue: shape.optNumber(o, "estimatedTaxDue", where),
      artifacts: artifacts.map((a, j) => {
        const aw = `${where}.artifacts[${j}]`;
        const ao = shape.record(a, aw);
        const files = ao["files"] === void 0 || ao["files"] === null ? [] : shape.array(ao["files"], `${aw}.files`);
        return {
          returnConfirmation: shape.optString(ao, "returnConfirmation", aw),
          paymentConfirmation: shape.optString(ao, "paymentConfirmation", aw),
          amountPaid: shape.optNumber(ao, "amountPaid", aw),
          files: files.map((f, k) => {
            const fw = `${aw}.files[${k}]`;
            const fo = shape.record(f, fw);
            return { type: shape.string(fo, "type", fw), signedUrl: shape.string(fo, "signedUrl", fw) };
          })
        };
      })
    };
  });
  return { filings, nextCursor };
}
var FREQUENCY_BY_CODE = {
  M: "monthly",
  Q: "quarterly",
  SA: "semi_annual",
  A: "annual"
};
function mapFrequency(code) {
  if (code === null) return null;
  return FREQUENCY_BY_CODE[code] ?? "other";
}
var DOCUMENT_KIND_BY_TYPE = {
  FILING_RETURN: "return",
  FILING_PAYMENT: "payment",
  FILING_RETURN_PAYMENT: "return_and_payment",
  FILING_TEMPLATE: "template",
  FILING_OTHER: "other"
};
function mapDocumentKind(type) {
  return DOCUMENT_KIND_BY_TYPE[type] ?? "other";
}
function currentFrequencyCode(reg) {
  if (reg.frequencies.length === 0) return null;
  const sorted = [...reg.frequencies].sort((a, b) => a.startedAt < b.startedAt ? 1 : -1);
  return (sorted.find((f) => f.endedAt === null) ?? sorted[0]).code;
}
function mapRegistration(reg) {
  const raw = currentFrequencyCode(reg);
  return {
    jurisdiction: reg.state,
    taxId: reg.taxId,
    startedAt: reg.startedAt,
    endedAt: reg.endedAt,
    frequency: mapFrequency(raw),
    rawFrequencyCode: raw
  };
}
var round2 = (n) => Math.round(n * 100) / 100;
function mapFiling(f) {
  const withReturn = f.artifacts.find((a) => a.returnConfirmation !== null);
  const withPayment = f.artifacts.find((a) => a.paymentConfirmation !== null);
  const paid = f.artifacts.map((a) => a.amountPaid).filter((n) => n !== null);
  return {
    externalId: `${f.state}:${f.periodCode}`,
    jurisdiction: f.state,
    periodCode: f.periodCode,
    periodName: f.periodName,
    frequency: mapFrequency(f.frequencyCode),
    rawFrequencyCode: f.frequencyCode,
    dueOn: f.dueOn,
    isCompleted: f.isCompleted,
    estimatedTaxDue: f.estimatedTaxDue,
    returnConfirmation: withReturn?.returnConfirmation ?? null,
    paymentConfirmation: withPayment?.paymentConfirmation ?? null,
    amountPaid: paid.length > 0 ? round2(paid.reduce((s, n) => s + n, 0)) : null,
    documents: f.artifacts.flatMap((a) => a.files.map((file) => ({ kind: mapDocumentKind(file.type) })))
  };
}

// src/providers/zamp/adapter.ts
var LINK_TTL_MS = 55 * 60 * 1e3;
var MAX_PAGES = 500;
var ZampAdapter = class {
  key = "zamp";
  /**
   * Flip these only after Zamp confirms the capability in writing (see the question list).
   * Today the public docs describe no nexus-progress endpoint, no approval action and no webhooks.
   */
  capabilities = {
    registrations: true,
    filings: true,
    documents: true,
    nexusTracking: false,
    registrationApproval: false,
    webhooks: false
  };
  client;
  now;
  constructor(opts) {
    this.client = new ZampClient(opts);
    this.now = opts.now ?? Date.now;
  }
  async healthCheck(ctx) {
    await this.client.get("/companies", { companyId: ctx.providerCompanyId });
  }
  async listRegistrations(ctx) {
    const body = await this.client.get("/registrations", { companyId: ctx.providerCompanyId });
    return parseRegistrations(body).map(mapRegistration);
  }
  async listFilings(ctx, options = {}) {
    return (await this.fetchRawFilings(ctx, options)).map(mapFiling);
  }
  async getDocumentLink(ctx, ref) {
    const filings = await this.fetchRawFilings(ctx, {
      jurisdiction: ref.jurisdiction,
      minDueOn: ref.dueOn,
      maxDueOn: ref.dueOn
    });
    const filing = filings.find((f) => f.periodCode === ref.periodCode && f.dueOn === ref.dueOn);
    const file = filing?.artifacts.flatMap((a) => a.files).find((f) => mapDocumentKind(f.type) === ref.kind);
    if (!file) {
      throw new ProviderError(
        "not_found",
        this.key,
        `No ${ref.kind} document for ${ref.jurisdiction} ${ref.periodCode} at the provider`
      );
    }
    return { url: file.signedUrl, expiresAt: new Date(this.now() + LINK_TTL_MS).toISOString() };
  }
  async fetchRawFilings(ctx, options) {
    const all = [];
    const seen = /* @__PURE__ */ new Set();
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.client.get("/filings", {
        companyId: ctx.providerCompanyId,
        state: options.jurisdiction,
        minDueOn: options.minDueOn,
        maxDueOn: options.maxDueOn,
        isCompleted: options.isCompleted,
        cursor
      });
      const parsed = parseFilingsPage(body);
      all.push(...parsed.filings);
      if (parsed.nextCursor === null) return all;
      if (seen.has(parsed.nextCursor)) {
        throw new ProviderError("bad_response", this.key, "Provider returned a repeating pagination cursor");
      }
      seen.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
    throw new ProviderError("bad_response", this.key, `Pagination exceeded ${MAX_PAGES} pages`);
  }
};

// src/providers/registry.ts
var factories = /* @__PURE__ */ new Map([
  [
    "zamp",
    (connection, env, deps) => {
      const apiKey = readCredential(connection, env);
      const baseUrl = env["ZAMP_BASE_URL"];
      return new ZampAdapter({
        apiKey,
        ...baseUrl ? { baseUrl } : {},
        ...deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}
      });
    }
  ]
]);
function knownProviders() {
  return [...factories.keys()];
}
function isKnownProvider(providerKey) {
  return factories.has(providerKey);
}
function buildAdapter(connection, env, deps = {}) {
  const factory = factories.get(connection.providerKey);
  if (!factory) {
    throw new ProviderError("config", connection.providerKey, `No adapter registered for provider "${connection.providerKey}"`);
  }
  return factory(connection, env, deps);
}
function readCredential(connection, env) {
  if (connection.credentialEnc) {
    try {
      return decryptSecret(connection.credentialEnc, env["CREDENTIAL_ENCRYPTION_KEY"]);
    } catch (err) {
      throw new ProviderError("config", connection.providerKey, err instanceof Error ? err.message : "Stored credential is unreadable");
    }
  }
  const name = connection.credentialRef;
  const value = name ? env[name] : void 0;
  if (!value) {
    throw new ProviderError(
      "config",
      connection.providerKey,
      name ? `Credential "${name}" is not set in the environment` : "This connection has no credential configured"
    );
  }
  return value;
}

// src/sync/supabaseSource.ts
var CONNECTION_COLUMNS = "id,tenant_id,product,provider_key,provider_company_id,credential_ref,credential_enc,status";
function connectionFromRow(row) {
  return {
    id: String(row["id"]),
    tenantId: String(row["tenant_id"]),
    product: row["product"],
    providerKey: String(row["provider_key"]),
    providerCompanyId: row["provider_company_id"] ?? null,
    credentialRef: row["credential_ref"] ?? null,
    credentialEnc: row["credential_enc"] ?? null,
    status: row["status"]
  };
}
var SupabaseConnectionSource = class {
  db;
  /** Runs older than this are assumed dead. Must comfortably exceed the function's maximum duration. */
  staleAfter;
  constructor(db, staleAfter = "15 minutes") {
    this.db = db;
    this.staleAfter = staleAfter;
  }
  async listActive() {
    const { data, error } = await this.db.from("provider_connections").select(CONNECTION_COLUMNS).eq("status", "active").order("last_synced_at", { ascending: true, nullsFirst: true });
    if (error) throw new Error(`listActive failed: ${error.message}`);
    return (data ?? []).map((r) => connectionFromRow(r));
  }
  async getActive(id) {
    const { data, error } = await this.db.from("provider_connections").select(CONNECTION_COLUMNS).eq("id", id).eq("status", "active").maybeSingle();
    if (error) throw new Error(`getActive failed: ${error.message}`);
    return data ? connectionFromRow(data) : null;
  }
  async reapStale() {
    const { data, error } = await this.db.rpc("reap_stale_sync_runs", { p_max_age: this.staleAfter });
    if (error) throw new Error(`reapStale failed: ${error.message}`);
    return Number(data ?? 0);
  }
  async purgeThrottle() {
    const { data, error } = await this.db.rpc("purge_auth_throttle", { p_older_than: "1 day" });
    if (error) throw new Error(`purgeThrottle failed: ${error.message}`);
    return Number(data ?? 0);
  }
};

// src/sync/sync.ts
var AlreadyRunningError = class extends Error {
  constructor(connectionId) {
    super(`A sync is already running for connection ${connectionId}`);
    this.name = "AlreadyRunningError";
  }
};
async function syncConnection(connection, adapter, store, opts = {}) {
  const now = opts.now ?? (() => /* @__PURE__ */ new Date());
  if (connection.status !== "active") {
    return { connectionId: connection.id, status: "skipped", registrations: 0, filings: 0, error: null };
  }
  let runId;
  try {
    runId = await store.startRun(connection);
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      return { connectionId: connection.id, status: "skipped", registrations: 0, filings: 0, error: "already running" };
    }
    throw err;
  }
  const ctx = { providerCompanyId: connection.providerCompanyId };
  let registrations = 0;
  let filings = 0;
  try {
    const regs = adapter.capabilities.registrations ? await adapter.listRegistrations(ctx) : [];
    const fils = adapter.capabilities.filings ? await adapter.listFilings(ctx) : [];
    const syncedAt = now().toISOString();
    registrations = await store.upsertRegistrations(connection, regs, syncedAt);
    filings = await store.upsertFilings(connection, fils, syncedAt);
    await store.finishRun(connection, runId, {
      status: "succeeded",
      registrations,
      filings,
      error: null,
      finishedAt: now().toISOString()
    });
    return { connectionId: connection.id, status: "succeeded", registrations, filings, error: null };
  } catch (err) {
    const message = describeError(err);
    await store.finishRun(connection, runId, {
      status: "failed",
      registrations,
      filings,
      error: message,
      finishedAt: now().toISOString()
    });
    return { connectionId: connection.id, status: "failed", registrations, filings, error: message };
  }
}
async function syncAll(connections, resolveAdapter, store, opts = {}) {
  const results = new Array(connections.length);
  const limit = Math.max(1, opts.concurrency ?? 4);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= connections.length) return;
      const connection = connections[i];
      if (opts.shouldStop?.()) {
        results[i] = {
          connectionId: connection.id,
          status: "deferred",
          registrations: 0,
          filings: 0,
          error: "time budget exhausted before this connection was reached"
        };
        continue;
      }
      try {
        const adapter = resolveAdapter(connection);
        results[i] = await syncConnection(connection, adapter, store, opts);
      } catch (err) {
        results[i] = {
          connectionId: connection.id,
          status: "failed",
          registrations: 0,
          filings: 0,
          error: describeError(err)
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, connections.length) }, () => worker()));
  return results;
}
function describeError(err) {
  if (err instanceof ProviderError) return `${err.kind}: ${err.message}`;
  return "unexpected error during sync";
}

// src/sync/supabaseStore.ts
var CHUNK = 500;
var SupabaseStore = class {
  db;
  constructor(db) {
    this.db = db;
  }
  async startRun(connection) {
    const { data, error } = await this.db.from("sync_runs").insert({ connection_id: connection.id }).select("id").single();
    if (error && error.code === "23505") throw new AlreadyRunningError(connection.id);
    if (error || !data) throw new Error(`startRun failed: ${error?.message ?? "no row returned"}`);
    return data.id;
  }
  async upsertRegistrations(connection, rows, syncedAt) {
    const records = rows.map((r) => ({
      connection_id: connection.id,
      tenant_id: connection.tenantId,
      jurisdiction: r.jurisdiction,
      tax_id: r.taxId,
      started_at: r.startedAt,
      ended_at: r.endedAt,
      frequency: r.frequency,
      raw_frequency_code: r.rawFrequencyCode,
      synced_at: syncedAt
    }));
    await this.upsertChunked("registrations", records, "connection_id,jurisdiction,started_at");
    return records.length;
  }
  async upsertFilings(connection, rows, syncedAt) {
    const records = rows.map((f) => ({
      connection_id: connection.id,
      tenant_id: connection.tenantId,
      external_id: f.externalId,
      jurisdiction: f.jurisdiction,
      period_code: f.periodCode,
      period_name: f.periodName,
      frequency: f.frequency,
      raw_frequency_code: f.rawFrequencyCode,
      due_on: f.dueOn,
      is_completed: f.isCompleted,
      estimated_tax_due: f.estimatedTaxDue,
      return_confirmation: f.returnConfirmation,
      payment_confirmation: f.paymentConfirmation,
      amount_paid: f.amountPaid,
      documents: f.documents,
      synced_at: syncedAt
    }));
    await this.upsertChunked("filings", records, "connection_id,external_id");
    return records.length;
  }
  async finishRun(connection, runId, outcome) {
    const run = await this.db.from("sync_runs").update({
      finished_at: outcome.finishedAt,
      status: outcome.status,
      registrations_upserted: outcome.registrations,
      filings_upserted: outcome.filings,
      error: outcome.error
    }).eq("id", runId);
    if (run.error) throw new Error(`finishRun (run) failed: ${run.error.message}`);
    const patch = {
      last_sync_status: outcome.status,
      last_sync_error: outcome.error
    };
    if (outcome.status === "succeeded") patch["last_synced_at"] = outcome.finishedAt;
    const conn = await this.db.from("provider_connections").update(patch).eq("id", connection.id);
    if (conn.error) throw new Error(`finishRun (connection) failed: ${conn.error.message}`);
  }
  async upsertChunked(table, records, onConflict) {
    for (let i = 0; i < records.length; i += CHUNK) {
      const { error } = await this.db.from(table).upsert(records.slice(i, i + CHUNK), { onConflict });
      if (error) throw new Error(`upsert into ${table} failed: ${error.message}`);
    }
  }
};

// src/http/audit.ts
var SupabaseAuditSink = class {
  db;
  constructor(db) {
    this.db = db;
  }
  async record(entry) {
    const { error } = await this.db.from("audit_log").insert({
      tenant_id: entry.tenantId ?? null,
      actor_id: entry.actorId ?? null,
      action: entry.action,
      target: entry.target ?? null,
      detail: entry.detail ?? null
    });
    if (error) throw new Error(`audit insert failed: ${error.message}`);
  }
};

// src/http/authApi.ts
function classify(error) {
  const status = error?.status;
  if (status === void 0 || status === 0 || status >= 500) return "server";
  if (status === 429) return "rate";
  return "client";
}
function toUser(u) {
  const o = u;
  if (!o || typeof o.id !== "string" || typeof o.email !== "string") return null;
  return { id: o.id, email: o.email.toLowerCase(), isStaff: o.app_metadata?.taxcart_staff === true };
}
function toSession(session, fallbackUser) {
  const s = session;
  if (!s || typeof s.access_token !== "string" || typeof s.refresh_token !== "string") return null;
  const user = toUser(s.user ?? fallbackUser);
  if (!user) return null;
  const expiresIn = typeof s.expires_in === "number" && s.expires_in > 0 ? s.expires_in : 3600;
  return { tokens: { accessToken: s.access_token, refreshToken: s.refresh_token, expiresIn }, user };
}
var SupabaseAuthApi = class {
  makeClient;
  admin;
  log;
  constructor(makeClient, admin, log2 = () => {
  }) {
    this.makeClient = makeClient;
    this.admin = admin;
    this.log = log2;
  }
  async sendCode(email) {
    try {
      const { error } = await this.makeClient().auth.signInWithOtp({
        email,
        // Invite-only: never create an account just because someone typed an email.
        options: { shouldCreateUser: false }
      });
      if (!error) return "sent";
      if (classify(error) === "server") {
        this.log("auth.send_code.unavailable", { status: error.status ?? null, code: error.code ?? null });
        return "unavailable";
      }
      this.log("auth.send_code.rejected", { status: error.status ?? null, code: error.code ?? null });
      return "rejected";
    } catch {
      this.log("auth.send_code.unavailable", { thrown: true });
      return "unavailable";
    }
  }
  async verifyCode(email, code) {
    try {
      const { data, error } = await this.makeClient().auth.verifyOtp({ email, token: code, type: "email" });
      if (error) {
        const kind = classify(error);
        return { ok: false, reason: kind === "server" ? "unavailable" : kind === "rate" ? "rate_limited" : "invalid" };
      }
      const s = toSession(data?.session, data?.user);
      return s ? { ok: true, ...s } : { ok: false, reason: "invalid" };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }
  async refresh(refreshToken) {
    try {
      const { data, error } = await this.makeClient().auth.refreshSession({ refresh_token: refreshToken });
      if (error) {
        const kind = classify(error);
        return { ok: false, reason: kind === "server" ? "unavailable" : kind === "rate" ? "rate_limited" : "invalid" };
      }
      const s = toSession(data?.session, data?.user);
      return s ? { ok: true, ...s } : { ok: false, reason: "invalid" };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }
  async getUser(accessToken) {
    try {
      const { data, error } = await this.makeClient().auth.getUser(accessToken);
      if (error) return { ok: false, reason: classify(error) === "server" ? "unavailable" : "invalid" };
      const user = toUser(data?.user);
      return user ? { ok: true, user } : { ok: false, reason: "invalid" };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }
  async ensureUser(email) {
    try {
      const made = await this.admin.auth.admin.createUser({ email, email_confirm: true });
      const id = made.data?.user?.id;
      if (!made.error && typeof id === "string") return { id, created: true };
      const found = await this.admin.rpc("auth_user_id_by_email", { p_email: email });
      if (!found.error && typeof found.data === "string") return { id: found.data, created: false };
      this.log("auth.ensure_user_failed", { status: made.error?.status ?? null });
      return null;
    } catch {
      this.log("auth.ensure_user_failed", { thrown: true });
      return null;
    }
  }
  async revoke(accessToken) {
    try {
      await this.admin.auth.admin.signOut(accessToken, "local");
    } catch {
      this.log("auth.revoke_failed");
    }
  }
};

// src/http/config.ts
var ConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
};
var LOCAL_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
function loadConfig(env) {
  const problems = [];
  const origins = [];
  const rawOrigins = (env["APP_ORIGIN"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (rawOrigins.length === 0) problems.push("APP_ORIGIN is required (comma-separated list of allowed origins)");
  for (const raw of rawOrigins) {
    try {
      const u = new URL(raw);
      const local = LOCAL_HOSTS.has(u.hostname);
      if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
        problems.push(`APP_ORIGIN "${raw}" must be https (plain http is only allowed for localhost)`);
      } else {
        origins.push(u.origin);
      }
    } catch {
      problems.push(`APP_ORIGIN "${raw}" is not a valid URL`);
    }
  }
  const throttleSecret = env["AUTH_THROTTLE_SECRET"] ?? "";
  if (throttleSecret.length < 32) problems.push("AUTH_THROTTLE_SECRET is required and must be at least 32 characters");
  const cronSecretRaw = env["CRON_SECRET"] ?? "";
  if (cronSecretRaw !== "" && cronSecretRaw.length < 32) problems.push("CRON_SECRET must be at least 32 characters when set");
  const sessionDays = intSetting(env["SESSION_DAYS"], 14, 1, 90, "SESSION_DAYS", problems);
  const syncBudgetMs = intSetting(env["SYNC_BUDGET_MS"], 45e3, 1e3, 28e4, "SYNC_BUDGET_MS", problems);
  if (problems.length > 0) throw new ConfigError(`Invalid configuration:
 - ${problems.join("\n - ")}`);
  return {
    appOrigins: origins,
    secureCookies: origins.every((o) => o.startsWith("https:")),
    cronSecret: cronSecretRaw === "" ? null : cronSecretRaw,
    throttleSecret,
    sessionDays,
    syncBudgetMs
  };
}
function intSetting(raw, fallback, min, max, name, problems) {
  if (raw === void 0 || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

// src/http/mailer.ts
var DEFAULT_FROM = "Taxcart <portal@mail.taxcart.com.au>";
var DEFAULT_REPLY_TO = "consulting@taxcart.com.au";
var ResendMailer = class {
  apiKey;
  from;
  replyTo;
  fetchImpl;
  constructor(apiKey, from, replyTo, fetchImpl) {
    this.apiKey = apiKey;
    this.from = from;
    this.replyTo = replyTo;
    this.fetchImpl = fetchImpl;
  }
  async send(mail) {
    try {
      const res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [mail.to], reply_to: this.replyTo, subject: mail.subject, text: mail.text, html: mail.html }),
        signal: AbortSignal.timeout(8e3)
      });
      return res.ok;
    } catch {
      return false;
    }
  }
};
function buildMailer(env, fetchImpl) {
  if (env["INVITE_EMAILS_ENABLED"] !== "true") return void 0;
  const key = env["RESEND_API_KEY"];
  if (!key) return void 0;
  return new ResendMailer(key, env["INVITE_FROM"] || DEFAULT_FROM, env["INVITE_REPLY_TO"] || DEFAULT_REPLY_TO, fetchImpl);
}
function portalUrl(env, firstOrigin) {
  const set = env["PORTAL_URL"];
  if (set) {
    try {
      return new URL(set).toString();
    } catch {
    }
  }
  return `${firstOrigin}/vat/`;
}
var escHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function welcomeEmail(p) {
  const subject = "Welcome to the Taxcart VAT portal";
  const text = [
    `Welcome to Taxcart.`,
    ``,
    `Your VAT portal for ${p.clientName} is ready. This is where you send us your sales files and follow each VAT return from start to finish.`,
    ``,
    `To get started:`,
    `1. Open ${p.portalUrl}`,
    `2. Enter this email address (${p.to}) and ask for a sign-in code.`,
    `3. We email you a 6-digit code. Type it in to sign in. There is no password to remember.`,
    `4. Choose your filing and period, add your sales file (CSV or Excel), check it, and send it to us.`,
    ``,
    `Please use this exact email address to sign in. A different address will not see your company.`,
    ``,
    `Questions? Reply to this email or write to ${p.contact}.`,
    ``,
    `The Taxcart team`
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#EAF1FE;font-family:Arial,Helvetica,sans-serif;color:#0B1F4D"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px"><h1 style="font-size:20px;margin:0 0 12px">Welcome to Taxcart</h1><p style="line-height:1.5">Your VAT portal for <strong>${escHtml(p.clientName)}</strong> is ready. This is where you send us your sales files and follow each VAT return from start to finish.</p><ol style="line-height:1.6;padding-left:20px"><li>Open the portal below.</li><li>Enter this email address (<strong>${escHtml(p.to)}</strong>) and ask for a sign-in code.</li><li>We email you a 6-digit code. Type it in. There is no password to remember.</li><li>Choose your filing and period, add your sales file (CSV or Excel), check it, and send it to us.</li></ol><p style="margin:22px 0"><a href="${escHtml(p.portalUrl)}" style="background:#0A66F5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">Open your portal</a></p><p style="line-height:1.5;font-size:14px">Please use this exact email address to sign in. A different address will not see your company.</p><p style="line-height:1.5;font-size:14px">Questions? Reply to this email or write to <a href="mailto:${escHtml(p.contact)}">${escHtml(p.contact)}</a>.</p><p style="font-size:14px;margin-bottom:0">The Taxcart team</p></div></body></html>`;
  return { to: p.to, subject, text, html };
}

// src/http/throttle.ts
var SupabaseThrottle = class {
  db;
  constructor(db) {
    this.db = db;
  }
  async hit(bucket, limit, windowSeconds) {
    const { data, error } = await this.db.rpc("auth_throttle_hit", {
      p_bucket: bucket,
      p_limit: limit,
      p_window: `${windowSeconds} seconds`
    });
    if (error) throw new Error(`throttle hit failed: ${error.message}`);
    return data === true;
  }
  async reset(bucket) {
    const { error } = await this.db.rpc("auth_throttle_reset", { p_bucket: bucket });
    if (error) throw new Error(`throttle reset failed: ${error.message}`);
  }
};

// src/http/buildDeps.ts
var NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
var log = (event, fields) => {
  console.log(JSON.stringify({ event, ...fields }));
};
function required(env, name) {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
var cached;
function buildDeps(env) {
  if (cached && cached.env === env) return cached;
  const url = required(env, "SUPABASE_URL");
  const anonKey = required(env, "SUPABASE_ANON_KEY");
  const serviceKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");
  const config = loadConfig(env);
  const serviceDb = createClient(url, serviceKey, { auth: NO_SESSION });
  const anonClient = () => createClient(url, anonKey, { auth: NO_SESSION });
  const userDb = (accessToken) => createClient(url, anonKey, { auth: NO_SESSION, global: { headers: { Authorization: `Bearer ${accessToken}` } } });
  const resolveAdapter = (c) => buildAdapter(c, env);
  const deps = {
    config,
    auth: new SupabaseAuthApi(anonClient, serviceDb, log),
    throttle: new SupabaseThrottle(serviceDb),
    audit: new SupabaseAuditSink(serviceDb),
    userDb,
    serviceDb,
    resolveAdapter,
    fetchImpl: fetch,
    now: () => /* @__PURE__ */ new Date(),
    credentialKey: env["CREDENTIAL_ENCRYPTION_KEY"],
    mailer: buildMailer(env, fetch),
    portalUrl: portalUrl(env, config.appOrigins[0]),
    alertTo: env["STAFF_ALERT_TO"] || DEFAULT_REPLY_TO,
    log
  };
  const cron = {
    config,
    source: new SupabaseConnectionSource(serviceDb),
    store: new SupabaseStore(serviceDb),
    resolveAdapter,
    log
  };
  const staff = { source: cron.source, store: cron.store };
  cached = { env, deps, cron, staff };
  return cached;
}

// src/http/util.ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
var HttpError = class extends Error {
  status;
  code;
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
};
var BASE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff"
};
function jsonResponse(body, status = 200, extra = {}) {
  const headers = new Headers({ ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra.headers });
  for (const c of extra.setCookies ?? []) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}
function errorResponse(status, code, message, extra = {}) {
  return jsonResponse({ error: { code, message } }, status, extra);
}
function toErrorResponse(err, log2) {
  if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message);
  log2?.("http.unexpected_error", { name: err instanceof Error ? err.name : typeof err });
  return errorResponse(500, "internal_error", "Something went wrong. Please try again.");
}
function requireAllowedOrigin(request, config) {
  const origin = request.headers.get("origin");
  if (!origin || !config.appOrigins.includes(origin)) {
    throw new HttpError(403, "forbidden_origin", "This request was not allowed.");
  }
}
function requireMethod(request, method) {
  if (request.method !== method) throw new HttpError(405, "method_not_allowed", "Method not allowed.");
}
async function readJsonObject(request, maxBytes = 4096) {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "unsupported_media_type", "Send the request as JSON.");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "too_large", "Request is too large.");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "too_large", "Request is too large.");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_input", "The request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_input", "The request body must be a JSON object.");
  }
  return parsed;
}
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(value) {
  if (typeof value !== "string") throw new HttpError(400, "invalid_input", "Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new HttpError(400, "invalid_input", "Enter a valid email address.");
  return email;
}
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function bucketKey(secret, kind, value) {
  return createHmac("sha256", secret).update(`${kind}|${value}`).digest("hex");
}

// src/http/limits.ts
var LIMITS = {
  // Asking for a sign-in code (stops email flooding and probing)
  requestCode: {
    perEmail: { limit: 5, windowSeconds: 900 },
    perIp: { limit: 20, windowSeconds: 900 }
  },
  // Entering a code (stops guessing). 5 tries per 15 minutes against a 6-digit code leaves
  // an attacker roughly a 1-in-50,000 chance per window.
  verifyCode: {
    perEmail: { limit: 5, windowSeconds: 900 },
    perIp: { limit: 30, windowSeconds: 900 }
  },
  // Staff actions that create or change clients (stops a stolen staff session from spraying changes)
  staffWrite: {
    perUser: { limit: 40, windowSeconds: 3600 }
  },
  // VAT service: sales-file checks and submissions, replies, and the staff team's day-to-day changes
  vatUpload: { perUser: { limit: 60, windowSeconds: 3600 } },
  vatWrite: { perUser: { limit: 120, windowSeconds: 3600 } },
  vatInvite: { perUser: { limit: 30, windowSeconds: 3600 } },
  vatStaff: { perUser: { limit: 600, windowSeconds: 3600 } },
  // Document downloads per signed-in user
  download: {
    perUser: { limit: 60, windowSeconds: 600 }
  }
};

// src/http/session.ts
function cookieNames(config) {
  const prefix = config.secureCookies ? "__Host-" : "";
  return { access: `${prefix}tc_at`, refresh: `${prefix}tc_rt` };
}
function serialize(name, value, maxAgeSeconds, config) {
  if (/[\s;,"\\]/.test(value)) throw new Error("refusing to write a cookie value with unsafe characters");
  const parts = [`${name}=${value}`, "Path=/", `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`, "HttpOnly", "SameSite=Lax"];
  if (config.secureCookies) parts.push("Secure");
  return parts.join("; ");
}
function buildSessionCookies(tokens, config) {
  const names = cookieNames(config);
  return [
    serialize(names.access, tokens.accessToken, tokens.expiresIn, config),
    serialize(names.refresh, tokens.refreshToken, config.sessionDays * 86400, config)
  ];
}
function buildClearCookies(config) {
  const names = cookieNames(config);
  return [serialize(names.access, "", 0, config), serialize(names.refresh, "", 0, config)];
}
function readSessionCookies(request, config) {
  const names = cookieNames(config);
  const jar = /* @__PURE__ */ new Map();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return { accessToken: jar.get(names.access) || null, refreshToken: jar.get(names.refresh) || null };
}
var UNAVAILABLE = () => errorResponse(503, "unavailable", "We could not complete that right now. Please try again shortly.");
async function authenticate(request, deps) {
  const { config, auth } = deps;
  const { accessToken, refreshToken } = readSessionCookies(request, config);
  const hadCookies = accessToken !== null || refreshToken !== null;
  const unauthorized = () => ({
    ok: false,
    response: errorResponse(401, "unauthenticated", "Please sign in.", hadCookies ? { setCookies: buildClearCookies(config) } : {})
  });
  if (accessToken) {
    const u = await auth.getUser(accessToken);
    if (u.ok) return { ok: true, user: u.user, accessToken, setCookies: [] };
    if (u.reason === "unavailable") return { ok: false, response: UNAVAILABLE() };
  }
  if (!refreshToken) return unauthorized();
  const r = await auth.refresh(refreshToken);
  if (r.ok) return { ok: true, user: r.user, accessToken: r.tokens.accessToken, setCookies: buildSessionCookies(r.tokens, config) };
  if (r.reason === "invalid") return unauthorized();
  return { ok: false, response: UNAVAILABLE() };
}

// src/http/handlers/logo.ts
var MAX_LOGO_BYTES = 15e4;
function sniffImageType(bytes) {
  const starts = (sig, at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (bytes.length > 12 && starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (bytes.length > 12 && starts([255, 216, 255])) return "image/jpeg";
  if (bytes.length > 12 && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)) return "image/webp";
  return null;
}

// src/http/handlers/staff.ts
var PRODUCTS = /* @__PURE__ */ new Set(["us_sales_tax", "eu_vat"]);
var NOT_FOUND = () => new HttpError(404, "not_found", "Not found.");
async function requireStaff(request, deps) {
  const a = await authenticate(request, deps);
  if (!a.ok) return a.response;
  if (!a.user.isStaff) return errorResponse(404, "not_found", "Not found.", { setCookies: a.setCookies });
  return a;
}
async function throttleStaff(deps, userId) {
  const rule = LIMITS.staffWrite.perUser;
  let allowed;
  try {
    allowed = await deps.throttle.hit(bucketKey(deps.config.throttleSecret, "staff-write", userId), rule.limit, rule.windowSeconds);
  } catch {
    throw new HttpError(503, "unavailable", "We could not complete that right now. Please try again shortly.");
  }
  if (!allowed) throw new HttpError(429, "rate_limited", "Too many changes in a short time. Please wait a while and try again.");
}
async function listClients(request, deps) {
  try {
    requireMethod(request, "GET");
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    const [t, c, m, lg] = await Promise.all([
      deps.serviceDb.from("tenants").select("id,name,created_at").order("name", { ascending: true }),
      deps.serviceDb.from("provider_connections").select("id,tenant_id,product,provider_key,status,last_synced_at,last_sync_status,last_sync_error"),
      deps.serviceDb.from("tenant_members").select("tenant_id,user_id"),
      deps.serviceDb.from("tenant_logos").select("tenant_id")
    ]);
    if (t.error || c.error || m.error || lg.error) throw new Error("could not load clients");
    const withLogo = new Set((lg.data ?? []).map((r) => String(r["tenant_id"])));
    const connections = c.data ?? [];
    const members = m.data ?? [];
    return jsonResponse(
      {
        // Display names for the staff screen. Kept here (not in the static page) so clients' browsers never receive them.
        providers: knownProviders().map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1) })),
        clients: (t.data ?? []).map((tenant) => ({
          id: tenant["id"],
          name: tenant["name"],
          createdAt: tenant["created_at"] ?? null,
          users: members.filter((x) => x["tenant_id"] === tenant["id"]).length,
          hasLogo: withLogo.has(String(tenant["id"])),
          connections: connections.filter((x) => x["tenant_id"] === tenant["id"]).map((x) => ({
            id: x["id"],
            product: x["product"],
            provider: x["provider_key"],
            status: x["status"],
            lastSyncedAt: x["last_synced_at"] ?? null,
            lastSyncStatus: x["last_sync_status"] ?? null,
            lastSyncError: x["last_sync_error"] ?? null
          }))
        }))
      },
      200,
      { setCookies: s.setCookies }
    );
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
function cleanName(v) {
  const name = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 120) throw new HttpError(400, "invalid_input", "Enter the client's name (2 to 120 characters).");
  return name;
}
function cleanToken(v) {
  const token = typeof v === "string" ? v.trim() : "";
  if (token.length < 10 || token.length > 600 || /\s/.test(token)) {
    throw new HttpError(400, "invalid_input", "Paste the full provider token (no spaces).");
  }
  return token;
}
function cleanCompanyId(v) {
  if (v === void 0 || v === null || v === "") return null;
  const id = typeof v === "string" ? v.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new HttpError(400, "invalid_input", "The provider's company ID can only contain letters, numbers, - and _.");
  return id;
}
async function runOneSync(connection, deps, staff) {
  const [result] = await syncAll([connection], deps.resolveAdapter, staff.store, { now: deps.now });
  return result;
}
function syncSummary(r) {
  return { status: r.status, registrations: r.registrations, filings: r.filings, error: r.error };
}
async function createClient2(request, deps, staff) {
  try {
    requireMethod(request, "POST");
    requireAllowedOrigin(request, deps.config);
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    await throttleStaff(deps, s.user.id);
    const body = await readJsonObject(request, 8192);
    const name = cleanName(body["name"]);
    const product = String(body["product"] ?? "");
    const provider = String(body["provider"] ?? "");
    if (!PRODUCTS.has(product)) throw new HttpError(400, "invalid_input", "Choose a service.");
    if (!isKnownProvider(provider)) throw new HttpError(400, "invalid_input", "That provider is not set up in the portal yet.");
    const token = cleanToken(body["token"]);
    const providerCompanyId = cleanCompanyId(body["providerCompanyId"]);
    const email = body["email"] === void 0 || body["email"] === "" ? null : normalizeEmail(body["email"]);
    let enc;
    try {
      enc = encryptSecret(token, deps.credentialKey);
    } catch (err) {
      if (err instanceof SecretBoxError) {
        deps.log("staff.encryption_not_configured");
        throw new HttpError(503, "encryption_not_configured", "Token storage is not set up yet (CREDENTIAL_ENCRYPTION_KEY is missing or invalid on the server).");
      }
      throw err;
    }
    const draft = {
      id: "draft",
      tenantId: "draft",
      product,
      providerKey: provider,
      providerCompanyId,
      credentialRef: null,
      credentialEnc: enc,
      status: "active"
    };
    try {
      await deps.resolveAdapter(draft).healthCheck({ providerCompanyId });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "auth") throw new HttpError(400, "token_rejected", "The provider did not accept that token. Check it was copied in full, and that it belongs to this client.");
      if (err instanceof ProviderError && err.kind === "config") throw new HttpError(503, "unavailable", "The portal could not use that token. Check the server settings.");
      deps.log("staff.token_check_failed", { kind: err instanceof ProviderError ? err.kind : "unexpected" });
      throw new HttpError(502, "provider_unavailable", "Could not reach the provider to check the token. Please try again shortly.");
    }
    const tenant = await deps.serviceDb.from("tenants").insert({ name }).select("id").single();
    const tenantId = tenant.data?.["id"];
    if (tenant.error || typeof tenantId !== "string") throw new Error("could not create client");
    const conn = await deps.serviceDb.from("provider_connections").insert({ tenant_id: tenantId, product, provider_key: provider, provider_company_id: providerCompanyId, credential_enc: enc, status: "active" }).select(CONNECTION_COLUMNS).single();
    if (conn.error || !conn.data) {
      await deps.serviceDb.from("tenants").delete().eq("id", tenantId);
      throw new Error("could not save connection");
    }
    const connection = connectionFromRow(conn.data);
    let invite = null;
    if (email) {
      const u = await deps.auth.ensureUser(email);
      if (u) {
        const link = await deps.serviceDb.from("tenant_members").insert({ tenant_id: tenantId, user_id: u.id, role: "owner" });
        invite = link.error ? "failed" : u.created ? "created" : "existing";
      } else {
        invite = "failed";
      }
    }
    try {
      await deps.audit.record({
        tenantId,
        actorId: s.user.id,
        action: "staff.client_created",
        target: `tenant:${tenantId}`,
        detail: { product, provider, invited: invite }
      });
    } catch {
      deps.log("audit.staff_not_recorded");
    }
    let sync;
    try {
      sync = syncSummary(await runOneSync(connection, deps, staff));
    } catch {
      sync = { status: "failed", registrations: 0, filings: 0, error: "first refresh could not run" };
    }
    return jsonResponse({ client: { id: tenantId, name }, connectionId: connection.id, invite, sync }, 201, { setCookies: s.setCookies });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
async function syncNow(request, deps, staff) {
  try {
    requireMethod(request, "POST");
    requireAllowedOrigin(request, deps.config);
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    await throttleStaff(deps, s.user.id);
    const body = await readJsonObject(request);
    const id = String(body["connectionId"] ?? "");
    if (!UUID_RE.test(id)) throw new HttpError(400, "invalid_input", "A valid connection is required.");
    const connection = await staff.source.getActive(id);
    if (!connection) throw NOT_FOUND();
    const result = await runOneSync(connection, deps, staff);
    return jsonResponse({ sync: syncSummary(result) }, 200, { setCookies: s.setCookies });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
var ROLES = /* @__PURE__ */ new Set(["owner", "member", "accountant"]);
async function listUsers(request, deps) {
  try {
    requireMethod(request, "GET");
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    const tenant = new URL(request.url).searchParams.get("tenant") ?? "";
    if (!UUID_RE.test(tenant)) throw new HttpError(400, "invalid_input", "A valid client is required.");
    const { data, error } = await deps.serviceDb.rpc("tenant_member_list", { p_tenant: tenant });
    if (error) throw new Error("could not load users");
    return jsonResponse(
      { users: (data ?? []).map((u) => ({ userId: u["user_id"], email: u["email"], role: u["role"] })) },
      200,
      { setCookies: s.setCookies }
    );
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
async function tenantExists(deps, tenantId) {
  const t = await deps.serviceDb.from("tenants").select("id").eq("id", tenantId).maybeSingle();
  if (t.error) throw new Error("could not load client");
  if (!t.data) throw NOT_FOUND();
}
async function addUser(request, deps) {
  try {
    requireMethod(request, "POST");
    requireAllowedOrigin(request, deps.config);
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    await throttleStaff(deps, s.user.id);
    const body = await readJsonObject(request);
    const tenantId = String(body["tenantId"] ?? "");
    const role = String(body["role"] ?? "");
    if (!UUID_RE.test(tenantId)) throw new HttpError(400, "invalid_input", "A valid client is required.");
    if (!ROLES.has(role)) throw new HttpError(400, "invalid_input", "Choose a role.");
    const email = normalizeEmail(body["email"]);
    await tenantExists(deps, tenantId);
    const u = await deps.auth.ensureUser(email);
    if (!u) throw new HttpError(502, "invite_failed", "The sign-in for that email could not be set up. Please try again shortly.");
    const already = await deps.serviceDb.from("tenant_members").select("user_id").eq("tenant_id", tenantId).eq("user_id", u.id).maybeSingle();
    if (already.error) throw new Error("could not check access");
    if (already.data) throw new HttpError(409, "already_member", "That person already has access to this client.");
    const link = await deps.serviceDb.from("tenant_members").insert({ tenant_id: tenantId, user_id: u.id, role });
    if (link.error) throw new Error("could not add user");
    try {
      await deps.audit.record({ tenantId, actorId: s.user.id, action: "staff.user_added", target: `user:${u.id}`, detail: { role, newSignIn: u.created } });
    } catch {
      deps.log("audit.staff_not_recorded");
    }
    let emailed = "off";
    if (body["welcome"] === true && deps.mailer && deps.portalUrl) {
      const t = await deps.serviceDb.from("tenants").select("name").eq("id", tenantId).maybeSingle();
      const name = String(t.data?.["name"] ?? "your company");
      emailed = await deps.mailer.send(welcomeEmail({ to: email, clientName: name, portalUrl: deps.portalUrl, contact: DEFAULT_REPLY_TO })) ? "sent" : "failed";
      if (emailed === "failed") deps.log("vat.welcome_email_failed");
    }
    return jsonResponse(body["welcome"] === true ? { ok: true, newSignIn: u.created, emailed } : { ok: true, newSignIn: u.created }, 201, { setCookies: s.setCookies });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
async function removeUser(request, deps) {
  try {
    requireMethod(request, "POST");
    requireAllowedOrigin(request, deps.config);
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    await throttleStaff(deps, s.user.id);
    const body = await readJsonObject(request);
    const tenantId = String(body["tenantId"] ?? "");
    const userId = String(body["userId"] ?? "");
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(userId)) throw new HttpError(400, "invalid_input", "A valid client and person are required.");
    const del = await deps.serviceDb.from("tenant_members").delete().eq("tenant_id", tenantId).eq("user_id", userId);
    if (del.error) throw new Error("could not remove user");
    try {
      await deps.audit.record({ tenantId, actorId: s.user.id, action: "staff.user_removed", target: `user:${userId}` });
    } catch {
      deps.log("audit.staff_not_recorded");
    }
    return jsonResponse({ ok: true }, 200, { setCookies: s.setCookies });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
async function setLogo(request, deps) {
  try {
    requireMethod(request, "POST");
    requireAllowedOrigin(request, deps.config);
    const s = await requireStaff(request, deps);
    if (s instanceof Response) return s;
    await throttleStaff(deps, s.user.id);
    const body = await readJsonObject(request, 26e4);
    const tenantId = String(body["tenantId"] ?? "");
    if (!UUID_RE.test(tenantId)) throw new HttpError(400, "invalid_input", "A valid client is required.");
    await tenantExists(deps, tenantId);
    if (body["remove"] === true) {
      const del = await deps.serviceDb.from("tenant_logos").delete().eq("tenant_id", tenantId);
      if (del.error) throw new Error("could not remove logo");
      await deps.audit.record({ tenantId, actorId: s.user.id, action: "staff.logo_removed", target: `tenant:${tenantId}` }).catch(() => deps.log("audit.staff_not_recorded"));
      return jsonResponse({ ok: true, hasLogo: false }, 200, { setCookies: s.setCookies });
    }
    const raw = typeof body["data"] === "string" ? body["data"] : "";
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new HttpError(400, "invalid_input", "Choose a PNG, JPEG or WebP image.");
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length > MAX_LOGO_BYTES) throw new HttpError(400, "too_large", "That image is too large. Please use one under 150 KB.");
    const type = sniffImageType(bytes);
    if (!type) throw new HttpError(400, "invalid_input", "Choose a PNG, JPEG or WebP image.");
    const save = await deps.serviceDb.from("tenant_logos").upsert({ tenant_id: tenantId, content_type: type, data_b64: bytes.toString("base64"), updated_at: deps.now().toISOString() });
    if (save.error) throw new Error("could not save logo");
    await deps.audit.record({ tenantId, actorId: s.user.id, action: "staff.logo_set", target: `tenant:${tenantId}`, detail: { type, bytes: bytes.length } }).catch(() => deps.log("audit.staff_not_recorded"));
    return jsonResponse({ ok: true, hasLogo: true }, 200, { setCookies: s.setCookies });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

// src/http/handlers/staffRouter.ts
function staffRoute(request, deps, staff) {
  const op = new URL(request.url).searchParams.get("op") ?? "";
  if (request.method === "GET") {
    if (op === "clients") return listClients(request, deps);
    if (op === "users") return listUsers(request, deps);
  } else if (request.method === "POST") {
    if (op === "create-client") return createClient2(request, deps, staff);
    if (op === "sync") return syncNow(request, deps, staff);
    if (op === "add-user") return addUser(request, deps);
    if (op === "remove-user") return removeUser(request, deps);
    if (op === "logo") return setLogo(request, deps);
  }
  return Promise.resolve(errorResponse(404, "not_found", "Not found."));
}

// entry/staff.ts
function GET(request) {
  const { deps, staff } = buildDeps(process.env);
  return staffRoute(request, deps, staff);
}
function POST(request) {
  const { deps, staff } = buildDeps(process.env);
  return staffRoute(request, deps, staff);
}
export {
  GET,
  POST
};
