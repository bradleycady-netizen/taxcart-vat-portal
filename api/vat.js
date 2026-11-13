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
    const detail2 = excerpt ? `: ${excerpt}` : "";
    const status = res.status;
    if (status === 401 || status === 403) {
      return new ProviderError("auth", PROVIDER, `Zamp rejected the credential (${status}) on ${path}${detail2}`, { status });
    }
    if (status === 404) return new ProviderError("not_found", PROVIDER, `Not found: ${path}${detail2}`, { status });
    if (status === 429) return new ProviderError("rate_limit", PROVIDER, `Rate limited on ${path}`, { status });
    if (status >= 500) return new ProviderError("upstream", PROVIDER, `Zamp error ${status} on ${path}${detail2}`, { status });
    return new ProviderError("bad_request", PROVIDER, `Zamp rejected the request (${status}) on ${path}${detail2}`, { status });
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

// src/http/handlers/vat.ts
import { createHash as createHash2 } from "node:crypto";

// src/vat/config.ts
var STATUSES = ["submitted", "received", "in_review", "return_prepared", "filed", "complete"];
var SCHEMES = ["uk_vat", "ioss", "oss", "local_vat"];
var SCHEME_INFO = {
  uk_vat: { label: "UK VAT", frequencies: ["monthly", "quarterly", "annual"], euOnlyDestinations: false },
  ioss: { label: "IOSS", frequencies: ["monthly"], euOnlyDestinations: true },
  oss: { label: "OSS", frequencies: ["quarterly"], euOnlyDestinations: true },
  local_vat: { label: "Local VAT", frequencies: ["monthly", "quarterly", "annual"], euOnlyDestinations: false }
};
var COUNTRIES = {
  AT: "Austria",
  BE: "Belgium",
  BG: "Bulgaria",
  HR: "Croatia",
  CY: "Cyprus",
  CZ: "Czechia",
  DK: "Denmark",
  EE: "Estonia",
  FI: "Finland",
  FR: "France",
  DE: "Germany",
  GR: "Greece",
  HU: "Hungary",
  IE: "Ireland",
  IT: "Italy",
  LV: "Latvia",
  LT: "Lithuania",
  LU: "Luxembourg",
  MT: "Malta",
  NL: "Netherlands",
  PL: "Poland",
  PT: "Portugal",
  RO: "Romania",
  SK: "Slovakia",
  SI: "Slovenia",
  ES: "Spain",
  SE: "Sweden",
  GB: "United Kingdom"
};
var EU_CODES = new Set(Object.keys(COUNTRIES).filter((c) => c !== "GB"));
var COUNTRY_ALIASES = { EL: "GR", UK: "GB" };
function countryName(code) {
  return COUNTRIES[code] ?? code;
}
function validRegistration(scheme, country, frequency) {
  if (!(country in COUNTRIES)) return "Choose a country from the list.";
  if (scheme === "uk_vat" && country !== "GB") return "UK VAT is for the United Kingdom.";
  if ((scheme === "ioss" || scheme === "oss") && country === "GB") return "IOSS and OSS are filed in an EU member state.";
  if (!SCHEME_INFO[scheme].frequencies.includes(frequency)) return `${SCHEME_INFO[scheme].label} returns are ${SCHEME_INFO[scheme].frequencies.join(" or ")}.`;
  return null;
}
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var pad = (n) => String(n).padStart(2, "0");
var iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
var lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function parsePeriod(code, frequency) {
  let m;
  if (frequency === "monthly" && (m = code.match(/^(\d{4})-(0[1-9]|1[0-2])$/))) {
    const y = Number(m[1]), mo = Number(m[2]);
    return { code, label: `${MONTHS[mo - 1]} ${y}`, start: iso(y, mo, 1), end: iso(y, mo, lastDay(y, mo)) };
  }
  if (frequency === "quarterly" && (m = code.match(/^(\d{4})-Q([1-4])$/))) {
    const y = Number(m[1]), q = Number(m[2]);
    const sm = (q - 1) * 3 + 1, em = sm + 2;
    return { code, label: `Q${q} ${y}`, start: iso(y, sm, 1), end: iso(y, em, lastDay(y, em)) };
  }
  if (frequency === "annual" && (m = code.match(/^(\d{4})$/))) {
    const y = Number(m[1]);
    return { code, label: String(y), start: iso(y, 1, 1), end: iso(y, 12, 31) };
  }
  return null;
}
function periodContaining(date, frequency) {
  const y = date.getUTCFullYear(), mo = date.getUTCMonth() + 1;
  const code = frequency === "monthly" ? `${y}-${pad(mo)}` : frequency === "quarterly" ? `${y}-Q${Math.ceil(mo / 3)}` : String(y);
  return parsePeriod(code, frequency);
}
function previousPeriod(p, frequency) {
  const d = /* @__PURE__ */ new Date(`${p.start}T00:00:00Z`);
  d.setUTCDate(0);
  return periodContaining(d, frequency);
}
function recentEndedPeriods(now, frequency, count = 4) {
  const today = now.toISOString().slice(0, 10);
  let p = periodContaining(now, frequency);
  if (p.end >= today) p = previousPeriod(p, frequency);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(p);
    p = previousPeriod(p, frequency);
  }
  return out;
}
function defaultDueDate(scheme, period) {
  const end = /* @__PURE__ */ new Date(`${period.end}T00:00:00Z`);
  if (scheme === "uk_vat") {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()));
    if (d.getUTCMonth() !== (end.getUTCMonth() + 1) % 12) d.setUTCDate(0);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  const y = end.getUTCFullYear(), mo = end.getUTCMonth() + 2;
  const ny = mo > 12 ? y + 1 : y, nm = mo > 12 ? mo - 12 : mo;
  return iso(ny, nm, lastDay(ny, nm));
}
function periodLabel(code) {
  return (parsePeriod(code, "monthly") ?? parsePeriod(code, "quarterly") ?? parsePeriod(code, "annual"))?.label ?? code;
}

// src/vat/csv.ts
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",", bestCount = 0;
  for (const d of [",", ";", "	"]) {
    let n = 0, inQ = false;
    for (const ch of firstLine) {
      if (ch === '"') inQ = !inQ;
      else if (ch === d && !inQ) n++;
    }
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}
function parseCsv(text, maxRows = 50001) {
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [], cell = "", inQ = false;
  const endRow = () => {
    row.push(cell);
    cell = "";
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") inQ = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      endRow();
      if (rows.length > maxRows) return rows;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
      if (rows.length > maxRows) return rows;
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

// src/vat/xlsx.ts
import { inflateRawSync } from "node:zlib";
var XlsxError = class extends Error {
};
var MAX_UNCOMPRESSED = 40 * 1024 * 1024;
var MAX_ROWS = 50001;
var MAX_COLS = 200;
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 101010256) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = /* @__PURE__ */ new Map();
  let budget = MAX_UNCOMPRESSED;
  for (let n = 0; n < count && n < 2e3; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 33639248) throw new XlsxError("bad zip directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + elen + clen;
    out.set(name, () => {
      if (usize > budget) throw new XlsxError("too large");
      budget -= usize;
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 67324752) throw new XlsxError("bad zip entry");
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) + 1024 });
      throw new XlsxError("unsupported compression");
    });
  }
  return out;
}
var decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e) => {
  if (e[0] === "#") {
    const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp > 0 && cp < 1114112 ? String.fromCodePoint(cp) : "";
  }
  return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()] ?? "";
});
var textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1])).join("");
function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, "").toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}
var BUILTIN_DATE = /* @__PURE__ */ new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
function dateStyles(xml) {
  const out = /* @__PURE__ */ new Set();
  if (!xml) return out;
  const custom = /* @__PURE__ */ new Set();
  for (const m of xml.matchAll(/<numFmt\s+[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    const code = decodeEntities(m[2]).replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, "");
    if (/[dmyh]/i.test(code) && !/^[#0.,%$\s-]*$/.test(code)) custom.add(Number(m[1]));
  }
  const xfs = xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)) {
    const id = Number(m[1].match(/numFmtId="(\d+)"/)?.[1] ?? 0);
    if (BUILTIN_DATE.has(id) || custom.has(id)) out.add(i);
    i++;
  }
  return out;
}
function serialToIso(serial) {
  const ms = Math.round((serial - 25569) * 864e5);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(serial) : d.toISOString().slice(0, 10);
}
function readXlsx(bytes) {
  try {
    const files = zipEntries(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const get = (name) => files.get(name)?.().toString("utf8") ?? null;
    let sheetPath = "xl/worksheets/sheet1.xml";
    const wb = get("xl/workbook.xml");
    const rels = get("xl/_rels/workbook.xml.rels");
    const rid = wb?.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
    if (rid && rels) {
      for (const m of rels.matchAll(/<Relationship\b([^>]*)>/g)) {
        if (m[1].includes(`Id="${rid}"`)) {
          const t = m[1].match(/Target="([^"]+)"/)?.[1];
          if (t) sheetPath = t.startsWith("/") ? t.slice(1) : `xl/${t}`;
        }
      }
    }
    const sheet = get(sheetPath);
    if (!sheet) throw new XlsxError("no worksheet");
    const shared = [];
    const ss = get("xl/sharedStrings.xml");
    if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")));
    const dates = dateStyles(get("xl/styles.xml"));
    const rows = [];
    let rowNo = 0;
    for (const r of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const explicit = Number(r[1].match(/\br="(\d+)"/)?.[1] ?? 0);
      rowNo = explicit > 0 ? explicit : rowNo + 1;
      if (rowNo > MAX_ROWS) throw new XlsxError("too many rows");
      const cells = [];
      let next = 0;
      for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
        const col = ref ? colIndex(ref) : next;
        if (col >= MAX_COLS) continue;
        next = col + 1;
        const type = attrs.match(/\bt="(\w+)"/)?.[1] ?? "n";
        const style = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? 0);
        const inner = c[2] ?? "";
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = textOf(inner);
        else if (type === "str" || type === "e") value = v === void 0 ? "" : decodeEntities(v);
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (v !== void 0) value = dates.has(style) && Number.isFinite(Number(v)) ? serialToIso(Number(v)) : decodeEntities(v);
        while (cells.length < col) cells.push("");
        cells[col] = value;
      }
      while (rows.length < rowNo - 1) rows.push([]);
      rows[rowNo - 1] = cells;
    }
    return rows;
  } catch (e) {
    if (e instanceof XlsxError) throw e;
    throw new XlsxError("unreadable workbook");
  }
}

// src/vat/validate.ts
var MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
var MAX_DATA_ROWS = 5e4;
var SAMPLE = 5;
var SYNONYMS = {
  date: ["createdat", "orderdate", "date", "paidat", "processedat", "invoicedate", "transactiondate", "created", "vatreportingdate", "paymentdate", "shippingdate"],
  country: ["shippingcountrycode", "shipcountrycode", "destinationcountrycode", "deliverycountrycode", "countrycode", "shippingcountry", "shipcountry", "destinationcountry", "deliverycountry", "shiptocountry", "country", "billingcountrycode", "billingcountry", "arrivalcountry", "vatcountry"],
  amount: ["subtotal", "netamount", "netsales", "net", "salesamount", "amount", "ordertotal", "total", "value", "lineitemprice", "itemnetprice"],
  currency: ["currency", "presentmentcurrency", "currencycode", "originalcurrency"],
  order: ["name", "ordernumber", "orderid", "order", "transactionid", "invoicenumber", "reference", "id"]
};
var EXPECTED = {
  date: "Created at, Order date or Date",
  country: "Shipping Country Code, Destination country or Country",
  amount: "Subtotal, Net amount or Amount"
};
var norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
var NOT_COUNTRIES = /* @__PURE__ */ new Set(["EU", "UN", "EZ", "QO", "AC", "CP", "DG", "EA", "IC", "TA", "XA", "XB", "ZZ"]);
var isoCodes = null;
var nameToCode = null;
function ensureCountryTables() {
  if (isoCodes) return;
  isoCodes = /* @__PURE__ */ new Set();
  nameToCode = /* @__PURE__ */ new Map();
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    let name;
    try {
      name = dn.of(code);
    } catch {
      continue;
    }
    if (!name || name === code || /^unknown/i.test(name) || NOT_COUNTRIES.has(code)) continue;
    isoCodes.add(code);
    nameToCode.set(norm(name), code);
  }
  for (const [n, c] of Object.entries({ usa: "US", unitedstatesofamerica: "US", uk: "GB", greatbritain: "GB", england: "GB", scotland: "GB", wales: "GB", czechrepublic: "CZ", holland: "NL", turkey: "TR", southkorea: "KR", russia: "RU" })) nameToCode.set(n, c);
}
function normalizeCountry(raw) {
  ensureCountryTables();
  const v = raw.trim();
  if (!v) return null;
  if (/^[A-Za-z]{2}$/.test(v)) {
    const up = v.toUpperCase();
    const code = COUNTRY_ALIASES[up] ?? up;
    return isoCodes.has(code) ? code : null;
  }
  return nameToCode.get(norm(v)) ?? null;
}
function parseAmount(raw) {
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^\d.,-]/g, "");
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  if (s.includes("-") || s === "") return null;
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    s = dec === "." ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    s = /,\d{1,2}$/.test(s) && s.split(",").length === 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? neg ? -n : n : null;
}
function parseDate(raw) {
  const v = raw.trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?![\d])/);
  let y, mo, d;
  if (m) {
    y = +m[1];
    mo = +m[2];
    d = +m[3];
  } else if (m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?![\d])/)) {
    const a = +m[1], b = +m[2];
    y = +m[3];
    if (a > 12 && b <= 12) {
      d = a;
      mo = b;
    } else if (b > 12 && a <= 12) {
      d = b;
      mo = a;
    } else {
      d = a;
      mo = b;
    }
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || y < 2e3 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function decodeText(bytes) {
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  if (text.includes("\0")) return null;
  return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}
var fail = (message, code = "unreadable") => ({ ok: false, errors: [{ code, message }], warnings: [], summary: null, fileType: null });
function checkSalesFile(fileName, bytes, ctx) {
  if (bytes.length === 0) return fail("That file is empty.", "empty");
  if (bytes.length > MAX_UPLOAD_BYTES) return fail("That file is larger than 4 MB. Please split it by month, or send it to your Taxcart contact.", "too_large");
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const isZip = bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4;
  const isOle = bytes[0] === 208 && bytes[1] === 207 && bytes[2] === 17 && bytes[3] === 224;
  if (isOle || ext === "xls") return fail("Old Excel (.xls) files are not supported. Please save the file as .xlsx or .csv and upload it again.", "xls");
  if (ext !== "csv" && ext !== "xlsx") return fail("Please upload a .csv or .xlsx file.", "file_type");
  let rows;
  let fileType;
  if (ext === "xlsx") {
    if (!isZip) return fail("That does not look like a real Excel (.xlsx) file. Please export it again.", "file_type");
    try {
      rows = readXlsx(bytes);
    } catch (e) {
      return fail(e instanceof XlsxError && /too (large|many)/.test(e.message) ? "That spreadsheet is too large to check. Please split it by month." : "We could not read that spreadsheet. Please export it again as .xlsx or .csv.");
    }
    fileType = "xlsx";
  } else {
    if (isZip) return fail("That file is an Excel workbook with a .csv name. Please save it as a real CSV, or upload it as .xlsx.", "file_type");
    const text = decodeText(bytes);
    if (text === null) return fail("That does not look like a CSV file. Please export it again.", "file_type");
    rows = parseCsv(text);
    fileType = "csv";
  }
  let headerAt = -1;
  let cols = null;
  for (let i = 0; i < Math.min(rows.length, 6) && !cols; i++) {
    const heads = (rows[i] ?? []).map((h) => norm(h ?? ""));
    const find = (list2) => {
      for (const s of list2) {
        const at = heads.indexOf(s);
        if (at >= 0) return at;
      }
      return -1;
    };
    const c = { date: find(SYNONYMS.date), country: find(SYNONYMS.country), amount: find(SYNONYMS.amount), currency: find(SYNONYMS.currency), order: find(SYNONYMS.order) };
    if (c.date >= 0 && c.country >= 0 && c.amount >= 0) {
      cols = c;
      headerAt = i;
    }
  }
  if (!cols) {
    const heads = (rows.find((r) => r.some((c) => c.trim() !== "")) ?? []).map((h) => h.trim()).filter(Boolean);
    const missing = [];
    const h0 = heads.map(norm);
    for (const k of ["date", "country", "amount"]) if (!SYNONYMS[k].some((s) => h0.includes(s))) missing.push(`${k === "date" ? "order date" : k === "country" ? "destination country" : "sales amount"} (for example: ${EXPECTED[k]})`);
    const found = heads.slice(0, 12).join(", ");
    return { ok: false, fileType, summary: null, warnings: [], errors: [{ code: "columns", message: `We could not find the ${missing.join(", the ")} column.${found ? ` The columns in your file are: ${found}${heads.length > 12 ? ", \u2026" : ""}.` : ""} Please upload the standard order export.` }] };
  }
  const errors = [];
  const warnings = [];
  const headerRow = rows[headerAt];
  const colName = (i) => (headerRow[i] ?? "").trim();
  const data = rows.slice(headerAt + 1);
  if (data.length > MAX_DATA_ROWS) return fail("That file has more than 50,000 rows. Please split it by month.", "too_many_rows");
  const blank = [], badDate = [], badCountry = [], badAmount = [], outside = [], nonEu = [], dupes = [];
  const countryRaw = /* @__PURE__ */ new Map();
  const byCountry = /* @__PURE__ */ new Map();
  const totals = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  let used = 0, dateFrom = null, dateTo = null, negatives = 0, noCurrency = 0;
  const cell = (r, i) => i >= 0 ? (r[i] ?? "").trim() : "";
  data.forEach((r, idx) => {
    const line = headerAt + idx + 2;
    const d = cell(r, cols.date), c = cell(r, cols.country), a = cell(r, cols.amount);
    if (!d && !c && !a) return;
    used++;
    if (!d || !c || !a) {
      blank.push(line);
      return;
    }
    const date = parseDate(d), country = normalizeCountry(c), amount = parseAmount(a);
    let bad = false;
    if (!date) {
      badDate.push(line);
      bad = true;
    }
    if (!country) {
      badCountry.push(line);
      countryRaw.set(c, (countryRaw.get(c) ?? 0) + 1);
      bad = true;
    }
    if (amount === null) {
      badAmount.push(line);
      bad = true;
    }
    if (bad || !date || !country || amount === null) return;
    const orderId = cell(r, cols.order);
    if (orderId) {
      const key = `${orderId}|${date}|${country}|${amount}`;
      if (seen.has(key)) dupes.push(line);
      seen.add(key);
    }
    if (date < ctx.period.start || date > ctx.period.end) outside.push(line);
    if (SCHEME_INFO[ctx.scheme].euOnlyDestinations && !EU_CODES.has(country)) nonEu.push(line);
    if (amount < 0) negatives++;
    const cur = (cell(r, cols.currency) || "").toUpperCase();
    if (!cur) noCurrency++;
    const curKey = cur || "\u2014";
    totals.set(curKey, (totals.get(curKey) ?? 0) + amount);
    const ct = byCountry.get(country) ?? { code: country, name: countryName(country), rows: 0, amount: 0 };
    ct.rows++;
    ct.amount += amount;
    byCountry.set(country, ct);
    if (!dateFrom || date < dateFrom) dateFrom = date;
    if (!dateTo || date > dateTo) dateTo = date;
  });
  const issue = (code, rows2, text) => ({ code, message: text(rows2.length), rows: rows2.slice(0, SAMPLE) });
  if (used === 0) errors.push({ code: "no_rows", message: "We found the column headings but no sales rows underneath them." });
  if (blank.length) errors.push(issue("blank", blank, (n) => `${n} row${n === 1 ? " is" : "s are"} missing an order date, destination country or amount.`));
  if (badDate.length) errors.push(issue("bad_date", badDate, (n) => `${n} row${n === 1 ? " has a date" : "s have dates"} we could not read. Use a format like 2026-10-31 or 31/10/2026.`));
  if (badCountry.length) {
    const names = [...countryRaw.keys()].slice(0, 4).map((s) => `\u201C${s}\u201D`).join(", ");
    errors.push(issue("bad_country", badCountry, (n) => `${n} row${n === 1 ? " has a country" : "s have countries"} that ${n === 1 ? "is" : "are"} not valid (${names}). Use two-letter codes like DE or FR, or the full country name.`));
  }
  if (badAmount.length) errors.push(issue("bad_amount", badAmount, (n) => `${n} row${n === 1 ? " has an amount" : "s have amounts"} we could not read as a number.`));
  if (outside.length) {
    const share = used ? outside.length / used : 0;
    const iss = issue("wrong_period", outside, (n) => `${n} row${n === 1 ? " is" : "s are"} dated outside ${ctx.period.label} (${ctx.period.start} to ${ctx.period.end}). Check you chose the right period.`);
    (share > 0.05 ? errors : warnings).push(iss);
  }
  if (nonEu.length) warnings.push(issue("non_eu", nonEu, (n) => `${n} row${n === 1 ? " ships" : "s ship"} outside the EU. ${SCHEME_INFO[ctx.scheme].label} covers EU destinations only, so Taxcart will ask about these.`));
  if (dupes.length) warnings.push(issue("duplicates", dupes, (n) => `${n} row${n === 1 ? " looks" : "s look"} like an exact repeat of an earlier order. Check nothing is counted twice.`));
  if (cols.currency < 0) warnings.push({ code: "no_currency", message: "There is no currency column, so we cannot tell which currency the amounts are in." });
  else if (noCurrency > 0) warnings.push({ code: "blank_currency", message: `${noCurrency} row${noCurrency === 1 ? " has" : "s have"} no currency.` });
  if (totals.size > 1 && cols.currency >= 0) warnings.push({ code: "mixed_currency", message: `The file mixes ${[...totals.keys()].join(", ")}. Totals are shown for each currency separately.` });
  if (negatives > 0) warnings.push({ code: "negatives", message: `${negatives} row${negatives === 1 ? " is" : "s are"} negative (refunds or returns). They are included in the totals.` });
  const result = {
    ok: errors.length === 0,
    errors,
    warnings,
    fileType,
    summary: {
      rows: used - blank.length - badDate.length - badCountry.length - badAmount.length,
      totals: [...totals].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })),
      byCountry: [...byCountry.values()].map((c) => ({ ...c, amount: Math.round(c.amount * 100) / 100 })).sort((x, y) => y.amount - x.amount).slice(0, 30),
      dateFrom,
      dateTo,
      columns: { date: colName(cols.date), country: colName(cols.country), amount: colName(cols.amount), currency: cols.currency >= 0 ? colName(cols.currency) : null, order: cols.order >= 0 ? colName(cols.order) : null }
    }
  };
  return result;
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
  vatStaff: { perUser: { limit: 600, windowSeconds: 3600 } },
  // Document downloads per signed-in user
  download: {
    perUser: { limit: 60, windowSeconds: 600 }
  }
};

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

// src/http/handlers/vat.ts
var BUCKET = "vat-files";
var NOT_FOUND = () => new HttpError(404, "not_found", "Not found.");
var UNAVAILABLE2 = () => new HttpError(503, "unavailable", "We could not complete that right now. Please try again shortly.");
async function requireUser(request, deps) {
  const a = await authenticate(request, deps);
  return a.ok ? a : a.response;
}
async function requireStaff(request, deps) {
  const a = await authenticate(request, deps);
  if (!a.ok) return a.response;
  if (!a.user.isStaff) return errorResponse(404, "not_found", "Not found.", { setCookies: a.setCookies });
  return a;
}
async function throttle(deps, kind, userId, rule) {
  let allowed;
  try {
    allowed = await deps.throttle.hit(bucketKey(deps.config.throttleSecret, kind, userId), rule.limit, rule.windowSeconds);
  } catch {
    throw UNAVAILABLE2();
  }
  if (!allowed) throw new HttpError(429, "rate_limited", "Too many requests in a short time. Please wait a while and try again.");
}
async function audit(deps, entry) {
  try {
    await deps.audit.record(entry);
  } catch {
    deps.log("audit.vat_not_recorded");
  }
}
var str = (v) => typeof v === "string" ? v : "";
function uuid(v, what = "item") {
  const s = str(v);
  if (!UUID_RE.test(s)) throw new HttpError(400, "invalid_input", `A valid ${what} is required.`);
  return s;
}
function oneOf(v, allowed, what) {
  const s = str(v);
  if (!allowed.includes(s)) throw new HttpError(400, "invalid_input", `Choose a valid ${what}.`);
  return s;
}
function cleanText(v, max = 2e3) {
  const s = str(v).replace(/\r\n/g, "\n").trim();
  if (s.length < 1 || s.length > max) throw new HttpError(400, "invalid_input", `Write a message of 1 to ${max} characters.`);
  return s;
}
var PREPARED = ["return_prepared", "filed", "complete"];
function mapReturn(r, tenantNames, staff = true) {
  const scheme = String(r["scheme"]);
  return {
    id: r["id"],
    tenantId: r["tenant_id"],
    ...tenantNames ? { tenantName: tenantNames.get(String(r["tenant_id"])) ?? "" } : {},
    scheme,
    schemeLabel: SCHEME_INFO[scheme]?.label ?? scheme,
    country: r["country"],
    countryName: countryName(String(r["country"])),
    periodCode: r["period_code"],
    periodLabel: periodLabel(String(r["period_code"])),
    periodEnd: r["period_end"],
    dueOn: r["due_on"] ?? null,
    status: r["status"],
    awaitingClient: r["awaiting_client"] === true,
    submittedAt: r["submitted_at"],
    updatedAt: r["updated_at"],
    filedAt: r["filed_at"] ?? null,
    upload: r["upload_path"] ? { name: r["upload_name"], bytes: r["upload_bytes"], rows: r["upload_rows"] } : null,
    returnFile: r["return_path"] && (staff || PREPARED.includes(String(r["status"]))) ? { name: r["return_name"], bytes: r["return_bytes"] } : null
  };
}
var RETURN_COLUMNS = "id,tenant_id,scheme,country,period_code,period_start,period_end,due_on,status,awaiting_client,submitted_at,updated_at,filed_at,upload_path,upload_name,upload_bytes,upload_rows,return_path,return_name,return_bytes";
async function requireCanWrite(deps, a, tenantId) {
  if (a.user.isStaff) return;
  const { data, error } = await deps.serviceDb.from("tenant_members").select("role").eq("tenant_id", tenantId).eq("user_id", a.user.id).maybeSingle();
  if (error) throw new Error("could not check access");
  if (!data) throw NOT_FOUND();
  if (data["role"] === "accountant") throw new HttpError(403, "read_only", "Your access to this account is view-only.");
}
async function readFileBody(request, max) {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/octet-stream\b/i.test(type)) throw new HttpError(415, "unsupported_media_type", "Send the file as raw data.");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max + 1024) throw new HttpError(413, "too_large", "That file is larger than 4 MB. Please split it by month, or send it to your Taxcart contact.");
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length > max) throw new HttpError(413, "too_large", "That file is larger than 4 MB. Please split it by month, or send it to your Taxcart contact.");
  return buf;
}
function cleanFileName(request, fallback) {
  let raw = request.headers.get("x-file-name") ?? "";
  try {
    raw = decodeURIComponent(raw);
  } catch {
    raw = "";
  }
  const base = raw.split(/[\\/]/).pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._ ()-]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100);
  return safe || fallback;
}
async function putObject(deps, path, bytes, contentType) {
  const store = () => deps.serviceDb.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false });
  let r = await store();
  if (r.error && /bucket not found/i.test(r.error.message)) {
    const made = await deps.serviceDb.storage.createBucket(BUCKET, { public: false });
    if (made.error && !/already exists/i.test(made.error.message)) throw new Error("could not create storage");
    r = await store();
  }
  if (r.error) throw new Error("could not store file");
}
async function removeObject(deps, path) {
  if (!path) return;
  try {
    await deps.serviceDb.storage.from(BUCKET).remove([path]);
  } catch {
    deps.log("vat.old_file_not_removed");
  }
}
async function loadReturnForStaffOrMember(deps, a, id) {
  const { data, error } = await deps.userDb(a.accessToken).from("vat_returns").select(RETURN_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error("could not load return");
  if (!data) throw NOT_FOUND();
  return data;
}
async function list(request, deps) {
  requireMethod(request, "GET");
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  const q = new URL(request.url).searchParams;
  const tenant = uuid(q.get("tenant"), "client");
  const asStaff = a.user.isStaff && q.get("preview") !== "1";
  const db = deps.userDb(a.accessToken);
  const [reg, ret] = await Promise.all([
    db.from("vat_registrations").select("id,scheme,country,frequency,vat_number").eq("tenant_id", tenant).order("scheme").order("country"),
    db.from("vat_returns").select(RETURN_COLUMNS).eq("tenant_id", tenant).order("period_start", { ascending: false }).limit(300)
  ]);
  if (reg.error || ret.error) throw new Error("could not load VAT data");
  const returns = ret.data ?? [];
  const now = deps.now();
  const registrations = (reg.data ?? []).map((r) => {
    const scheme = String(r["scheme"]);
    const frequency = String(r["frequency"]);
    const country = String(r["country"]);
    return {
      id: r["id"],
      scheme,
      schemeLabel: SCHEME_INFO[scheme].label,
      country,
      countryName: countryName(country),
      frequency,
      vatNumber: r["vat_number"] ?? null,
      periods: recentEndedPeriods(now, frequency, 4).map((p) => {
        const existing = returns.find((x) => x["scheme"] === scheme && x["country"] === country && x["period_code"] === p.code);
        return { code: p.code, label: p.label, start: p.start, end: p.end, dueOn: defaultDueDate(scheme, p), returnId: existing ? existing["id"] : null, status: existing ? existing["status"] : null };
      })
    };
  });
  const waiting = returns.filter((r) => r["awaiting_client"] === true).map((r) => String(r["id"]));
  const questions = /* @__PURE__ */ new Map();
  if (waiting.length) {
    const qs = await db.from("vat_events").select("return_id,body,created_at").eq("kind", "question").in("return_id", waiting).order("created_at", { ascending: true });
    if (qs.error) throw new Error("could not load questions");
    for (const e of qs.data ?? []) questions.set(String(e["return_id"]), { body: e["body"], at: e["created_at"] });
  }
  return jsonResponse({ registrations, returns: returns.map((r) => ({ ...mapReturn(r, void 0, asStaff), question: questions.get(String(r["id"])) ?? null })) }, 200, { setCookies: a.setCookies });
}
async function detail(request, deps) {
  requireMethod(request, "GET");
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  const dq = new URL(request.url).searchParams;
  const id = uuid(dq.get("id"), "return");
  const asStaff = a.user.isStaff && dq.get("preview") !== "1";
  const row = await loadReturnForStaffOrMember(deps, a, id);
  const ev = await deps.userDb(a.accessToken).from("vat_events").select("id,actor_side,kind,to_status,body,created_at").eq("return_id", id).order("created_at", { ascending: true }).limit(500);
  if (ev.error) throw new Error("could not load history");
  const names = /* @__PURE__ */ new Map();
  if (asStaff) {
    const t = await deps.serviceDb.from("tenants").select("id,name").eq("id", String(row["tenant_id"])).maybeSingle();
    if (t.data) names.set(String(t.data["id"]), String(t.data["name"]));
  }
  const summary = asStaff ? await deps.serviceDb.from("vat_returns").select("upload_summary").eq("id", id).maybeSingle() : null;
  return jsonResponse(
    {
      return: mapReturn(row, asStaff ? names : void 0, asStaff),
      ...summary?.data ? { uploadSummary: summary.data["upload_summary"] ?? null } : {},
      events: (ev.data ?? []).map((e) => ({ id: e["id"], side: e["actor_side"], kind: e["kind"], status: e["to_status"] ?? null, body: e["body"] ?? null, at: e["created_at"] }))
    },
    200,
    { setCookies: a.setCookies }
  );
}
async function download(request, deps) {
  requireMethod(request, "GET");
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  await throttle(deps, "download", a.user.id, LIMITS.download.perUser);
  const q = new URL(request.url).searchParams;
  const id = uuid(q.get("id"), "return");
  const kind = oneOf(q.get("kind"), ["upload", "return"], "file");
  const row = await loadReturnForStaffOrMember(deps, a, id);
  const path = str(kind === "upload" ? row["upload_path"] : row["return_path"]);
  const name = str(kind === "upload" ? row["upload_name"] : row["return_name"]) || "file";
  if (!path) throw NOT_FOUND();
  if (kind === "return" && !a.user.isStaff && !["return_prepared", "filed", "complete"].includes(String(row["status"]))) throw NOT_FOUND();
  const signed = await deps.serviceDb.storage.from(BUCKET).createSignedUrl(path, 60, { download: name });
  if (signed.error || !signed.data?.signedUrl) throw new Error("could not sign link");
  await audit(deps, { tenantId: String(row["tenant_id"]), actorId: a.user.id, action: "vat.download", target: `vat_return:${id}`, detail: { kind } });
  return jsonResponse({ url: signed.data.signedUrl, name }, 200, { setCookies: a.setCookies });
}
async function readUploadContext(request, deps, a) {
  requireAllowedOrigin(request, deps.config);
  const q = new URL(request.url).searchParams;
  const tenant = uuid(q.get("tenant"), "client");
  const scheme = oneOf(q.get("scheme"), SCHEMES, "scheme");
  const country = str(q.get("country")).toUpperCase();
  if (!(country in COUNTRIES)) throw new HttpError(400, "invalid_input", "Choose a valid country.");
  await requireCanWrite(deps, a, tenant);
  const reg = await deps.serviceDb.from("vat_registrations").select("id,frequency").eq("tenant_id", tenant).eq("scheme", scheme).eq("country", country).maybeSingle();
  if (reg.error) throw new Error("could not check registration");
  if (!reg.data) throw new HttpError(400, "not_registered", "That filing is not set up for your account. Please contact your Taxcart representative.");
  const frequency = String(reg.data["frequency"]);
  const period = parsePeriod(str(q.get("period")), frequency);
  if (!period) throw new HttpError(400, "invalid_input", "Choose a valid period.");
  if (period.end >= deps.now().toISOString().slice(0, 10)) throw new HttpError(400, "period_open", "That period has not finished yet. You can upload once it has ended.");
  const behalf = a.user.isStaff && q.get("behalf") === "1";
  return { tenant, scheme, country, period, behalf, registrationId: String(reg.data["id"]) };
}
async function check(request, deps) {
  requireMethod(request, "POST");
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  const ctx = await readUploadContext(request, deps, a);
  await throttle(deps, "vat-upload", a.user.id, LIMITS.vatUpload.perUser);
  const bytes = await readFileBody(request, MAX_UPLOAD_BYTES);
  const result = checkSalesFile(cleanFileName(request, "file"), bytes, { scheme: ctx.scheme, period: ctx.period });
  return jsonResponse({ result }, 200, { setCookies: a.setCookies });
}
async function submit(request, deps) {
  requireMethod(request, "POST");
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  const ctx = await readUploadContext(request, deps, a);
  await throttle(deps, "vat-upload", a.user.id, LIMITS.vatUpload.perUser);
  const bytes = await readFileBody(request, MAX_UPLOAD_BYTES);
  const fileName = cleanFileName(request, "sales-file");
  const result = checkSalesFile(fileName, bytes, { scheme: ctx.scheme, period: ctx.period });
  if (!result.ok || !result.summary) return jsonResponse({ result }, 422, { setCookies: a.setCookies });
  const existing = await deps.serviceDb.from("vat_returns").select("id,status,upload_path").eq("tenant_id", ctx.tenant).eq("scheme", ctx.scheme).eq("country", ctx.country).eq("period_code", ctx.period.code).maybeSingle();
  if (existing.error) throw new Error("could not check existing return");
  const prior = existing.data;
  if (prior && prior["status"] !== "submitted") throw new HttpError(409, "already_received", "Taxcart has already started on this return. Please send any changes as a message on the return instead.");
  const digest = createHash2("sha256").update(bytes).digest("hex").slice(0, 12);
  const ext = result.fileType === "xlsx" ? "xlsx" : "csv";
  const returnId = prior ? String(prior["id"]) : crypto.randomUUID();
  const path = `${ctx.tenant}/${returnId}/upload-${digest}.${ext}`;
  await putObject(deps, path, bytes, ext === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv");
  const fields = {
    upload_path: path,
    upload_name: fileName,
    upload_bytes: bytes.length,
    upload_rows: result.summary.rows,
    upload_summary: { summary: result.summary, warnings: result.warnings },
    submitted_by: a.user.id,
    submitted_at: deps.now().toISOString(),
    updated_at: deps.now().toISOString()
  };
  if (prior) {
    const up = await deps.serviceDb.from("vat_returns").update(fields).eq("id", returnId);
    if (up.error) {
      await removeObject(deps, path);
      throw new Error("could not update return");
    }
    if (prior["upload_path"] !== path) await removeObject(deps, str(prior["upload_path"]));
  } else {
    const ins = await deps.serviceDb.from("vat_returns").insert({
      id: returnId,
      tenant_id: ctx.tenant,
      registration_id: ctx.registrationId,
      scheme: ctx.scheme,
      country: ctx.country,
      period_code: ctx.period.code,
      period_start: ctx.period.start,
      period_end: ctx.period.end,
      due_on: defaultDueDate(ctx.scheme, ctx.period),
      status: "submitted",
      ...fields
    });
    if (ins.error) {
      await removeObject(deps, path);
      if (ins.error.code === "23505") throw new HttpError(409, "already_received", "A file for that period has just been submitted. Please refresh the page.");
      throw new Error("could not save return");
    }
  }
  await deps.serviceDb.from("vat_events").insert({ return_id: returnId, tenant_id: ctx.tenant, actor_id: a.user.id, actor_side: a.user.isStaff && !ctx.behalf ? "staff" : "client", kind: prior ? "file_replaced" : "submitted", body: fileName });
  await audit(deps, { tenantId: ctx.tenant, actorId: a.user.id, action: prior ? "vat.file_replaced" : "vat.submitted", target: `vat_return:${returnId}`, detail: { scheme: ctx.scheme, country: ctx.country, period: ctx.period.code, rows: result.summary.rows, ...ctx.behalf ? { onBehalfOfClient: true } : {} } });
  return jsonResponse({ id: returnId, replaced: Boolean(prior), result }, prior ? 200 : 201, { setCookies: a.setCookies });
}
async function reply(request, deps) {
  requireMethod(request, "POST");
  requireAllowedOrigin(request, deps.config);
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  await throttle(deps, "vat-write", a.user.id, LIMITS.vatWrite.perUser);
  const body = await readJsonObject(request, 8192);
  const id = uuid(body["id"], "return");
  const text = cleanText(body["body"]);
  const row = await loadReturnForStaffOrMember(deps, a, id);
  const tenant = String(row["tenant_id"]);
  await requireCanWrite(deps, a, tenant);
  const side = a.user.isStaff && body["behalf"] !== true ? "staff" : "client";
  const ins = await deps.serviceDb.from("vat_events").insert({ return_id: id, tenant_id: tenant, actor_id: a.user.id, actor_side: side, kind: "reply", body: text });
  if (ins.error) throw new Error("could not save reply");
  if (a.user.isStaff && side === "client") await audit(deps, { tenantId: tenant, actorId: a.user.id, action: "vat.reply_on_behalf", target: `vat_return:${id}` });
  if (side === "client") await deps.serviceDb.from("vat_returns").update({ awaiting_client: false, updated_at: deps.now().toISOString() }).eq("id", id);
  return jsonResponse({ ok: true }, 201, { setCookies: a.setCookies });
}
async function queue(request, deps) {
  requireMethod(request, "GET");
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  const [r, t] = await Promise.all([
    deps.serviceDb.from("vat_returns").select(RETURN_COLUMNS).order("due_on", { ascending: true, nullsFirst: false }).limit(1e3),
    deps.serviceDb.from("tenants").select("id,name")
  ]);
  if (r.error || t.error) throw new Error("could not load queue");
  const names = new Map((t.data ?? []).map((x) => [String(x["id"]), String(x["name"])]));
  return jsonResponse({ returns: (r.data ?? []).map((x) => mapReturn(x, names)) }, 200, { setCookies: s.setCookies });
}
async function clients(request, deps) {
  requireMethod(request, "GET");
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  const [t, r, m] = await Promise.all([
    deps.serviceDb.from("tenants").select("id,name").order("name", { ascending: true }),
    deps.serviceDb.from("vat_registrations").select("id,tenant_id,scheme,country,frequency,vat_number").order("country"),
    deps.serviceDb.from("tenant_members").select("tenant_id")
  ]);
  if (t.error || r.error || m.error) throw new Error("could not load clients");
  const regs = r.data ?? [];
  const members = m.data ?? [];
  return jsonResponse(
    {
      clients: (t.data ?? []).map((c) => ({
        id: c["id"],
        name: c["name"],
        users: members.filter((x) => x["tenant_id"] === c["id"]).length,
        registrations: regs.filter((x) => x["tenant_id"] === c["id"]).map((x) => ({ id: x["id"], scheme: x["scheme"], schemeLabel: SCHEME_INFO[String(x["scheme"])]?.label, country: x["country"], countryName: countryName(String(x["country"])), frequency: x["frequency"], vatNumber: x["vat_number"] ?? null }))
      })),
      countries: Object.entries(COUNTRIES).map(([code, name]) => ({ code, name })),
      schemes: SCHEMES.map((k) => ({ key: k, label: SCHEME_INFO[k].label, frequencies: SCHEME_INFO[k].frequencies }))
    },
    200,
    { setCookies: s.setCookies }
  );
}
async function setStatus(request, deps) {
  requireMethod(request, "POST");
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, "vat-staff", s.user.id, LIMITS.vatStaff.perUser);
  const body = await readJsonObject(request, 8192);
  const id = uuid(body["id"], "return");
  const status = oneOf(body["status"], STATUSES, "status");
  const row = await deps.serviceDb.from("vat_returns").select("id,tenant_id,status,due_on,return_path").eq("id", id).maybeSingle();
  if (row.error) throw new Error("could not load return");
  if (!row.data) throw NOT_FOUND();
  const cur = row.data;
  if ((status === "filed" || status === "complete") && !cur["return_path"]) throw new HttpError(400, "return_missing", "Attach the return PDF before marking it Filed or Complete.");
  const update = { status, updated_at: deps.now().toISOString() };
  if (status === "filed" && cur["status"] !== "filed" && cur["status"] !== "complete") update["filed_at"] = deps.now().toISOString();
  let dueChanged = false;
  if (body["dueOn"] !== void 0 && body["dueOn"] !== null && body["dueOn"] !== "") {
    const due = str(body["dueOn"]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due))) throw new HttpError(400, "invalid_input", "Enter the due date as a real date.");
    if (due !== cur["due_on"]) {
      update["due_on"] = due;
      dueChanged = true;
    }
  }
  const note = body["note"] ? cleanText(body["note"]) : null;
  const up = await deps.serviceDb.from("vat_returns").update(update).eq("id", id);
  if (up.error) throw new Error("could not update return");
  const tenant = String(cur["tenant_id"]);
  const events = [];
  if (status !== cur["status"]) events.push({ return_id: id, tenant_id: tenant, actor_id: s.user.id, actor_side: "staff", kind: "status", to_status: status, body: note });
  if (dueChanged) events.push({ return_id: id, tenant_id: tenant, actor_id: s.user.id, actor_side: "staff", kind: "due_changed", body: String(update["due_on"]) });
  if (events.length) await deps.serviceDb.from("vat_events").insert(events);
  await audit(deps, { tenantId: tenant, actorId: s.user.id, action: "vat.status", target: `vat_return:${id}`, detail: { from: cur["status"], to: status } });
  return jsonResponse({ ok: true }, 200, { setCookies: s.setCookies });
}
async function ask(request, deps) {
  requireMethod(request, "POST");
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, "vat-staff", s.user.id, LIMITS.vatStaff.perUser);
  const body = await readJsonObject(request, 8192);
  const id = uuid(body["id"], "return");
  const text = cleanText(body["body"]);
  const row = await deps.serviceDb.from("vat_returns").select("tenant_id").eq("id", id).maybeSingle();
  if (row.error) throw new Error("could not load return");
  if (!row.data) throw NOT_FOUND();
  const ins = await deps.serviceDb.from("vat_events").insert({ return_id: id, tenant_id: String(row.data["tenant_id"]), actor_id: s.user.id, actor_side: "staff", kind: "question", body: text });
  if (ins.error) throw new Error("could not save question");
  await deps.serviceDb.from("vat_returns").update({ awaiting_client: true, updated_at: deps.now().toISOString() }).eq("id", id);
  return jsonResponse({ ok: true }, 201, { setCookies: s.setCookies });
}
async function attachReturn(request, deps) {
  requireMethod(request, "POST");
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, "vat-staff", s.user.id, LIMITS.vatStaff.perUser);
  const id = uuid(new URL(request.url).searchParams.get("id"), "return");
  const bytes = await readFileBody(request, MAX_UPLOAD_BYTES);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
  if (!head.startsWith("%PDF-")) throw new HttpError(400, "file_type", "Please attach a PDF file.");
  const row = await deps.serviceDb.from("vat_returns").select("tenant_id,return_path").eq("id", id).maybeSingle();
  if (row.error) throw new Error("could not load return");
  if (!row.data) throw NOT_FOUND();
  const cur = row.data;
  const tenant = String(cur["tenant_id"]);
  const name = cleanFileName(request, "vat-return.pdf").replace(/(\.pdf)?$/i, ".pdf");
  const path = `${tenant}/${id}/return-${createHash2("sha256").update(bytes).digest("hex").slice(0, 12)}.pdf`;
  if (path !== cur["return_path"]) await putObject(deps, path, bytes, "application/pdf");
  const up = await deps.serviceDb.from("vat_returns").update({ return_path: path, return_name: name, return_bytes: bytes.length, updated_at: deps.now().toISOString() }).eq("id", id);
  if (up.error) {
    if (path !== cur["return_path"]) await removeObject(deps, path);
    throw new Error("could not save return file");
  }
  if (cur["return_path"] && cur["return_path"] !== path) await removeObject(deps, str(cur["return_path"]));
  await deps.serviceDb.from("vat_events").insert({ return_id: id, tenant_id: tenant, actor_id: s.user.id, actor_side: "staff", kind: "return_attached", body: name });
  await audit(deps, { tenantId: tenant, actorId: s.user.id, action: "vat.return_attached", target: `vat_return:${id}` });
  return jsonResponse({ ok: true }, 201, { setCookies: s.setCookies });
}
async function register(request, deps) {
  requireMethod(request, "POST");
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, "vat-staff", s.user.id, LIMITS.vatStaff.perUser);
  const body = await readJsonObject(request, 4096);
  const tenant = uuid(body["tenantId"], "client");
  const scheme = oneOf(body["scheme"], SCHEMES, "scheme");
  const country = str(body["country"]).toUpperCase();
  const frequency = oneOf(body["frequency"], ["monthly", "quarterly", "annual"], "frequency");
  const problem = validRegistration(scheme, country, frequency);
  if (problem) throw new HttpError(400, "invalid_input", problem);
  const vat = str(body["vatNumber"]).trim().toUpperCase();
  if (vat && !/^[A-Z0-9 ]{4,40}$/.test(vat)) throw new HttpError(400, "invalid_input", "The VAT number can only contain letters and numbers.");
  const t = await deps.serviceDb.from("tenants").select("id").eq("id", tenant).maybeSingle();
  if (t.error) throw new Error("could not check client");
  if (!t.data) throw NOT_FOUND();
  const ins = await deps.serviceDb.from("vat_registrations").insert({ tenant_id: tenant, scheme, country, frequency, vat_number: vat || null });
  if (ins.error) {
    if (ins.error.code === "23505") throw new HttpError(409, "exists", "That filing is already set up for this client.");
    throw new Error("could not save registration");
  }
  await audit(deps, { tenantId: tenant, actorId: s.user.id, action: "vat.registration_added", detail: { scheme, country, frequency } });
  return jsonResponse({ ok: true }, 201, { setCookies: s.setCookies });
}
async function unregister(request, deps) {
  requireMethod(request, "POST");
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, "vat-staff", s.user.id, LIMITS.vatStaff.perUser);
  const id = uuid((await readJsonObject(request, 2048))["id"], "filing");
  const del = await deps.serviceDb.from("vat_registrations").delete().eq("id", id);
  if (del.error) throw new Error("could not remove registration");
  await audit(deps, { actorId: s.user.id, action: "vat.registration_removed", target: `vat_registration:${id}` });
  return jsonResponse({ ok: true }, 200, { setCookies: s.setCookies });
}
async function createClient2(request, deps) {
  requireMethod(request, "POST");
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, "vat-staff", s.user.id, LIMITS.vatStaff.perUser);
  const body = await readJsonObject(request, 4096);
  const name = str(body["name"]).trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 120) throw new HttpError(400, "invalid_input", "Enter the client's name (2 to 120 characters).");
  const email = body["email"] ? normalizeEmail(body["email"]) : null;
  const t = await deps.serviceDb.from("tenants").insert({ name }).select("id").single();
  const tenantId = t.data?.["id"];
  if (t.error || typeof tenantId !== "string") throw new Error("could not create client");
  let invite = null;
  if (email) {
    const u = await deps.auth.ensureUser(email);
    if (u) {
      const link = await deps.serviceDb.from("tenant_members").insert({ tenant_id: tenantId, user_id: u.id, role: "owner" });
      invite = link.error ? "failed" : u.created ? "created" : "existing";
    } else invite = "failed";
  }
  await audit(deps, { tenantId, actorId: s.user.id, action: "vat.client_created", target: `tenant:${tenantId}`, detail: { invited: invite } });
  return jsonResponse({ client: { id: tenantId, name }, invite }, 201, { setCookies: s.setCookies });
}
async function vatRoute(request, deps) {
  try {
    const op = new URL(request.url).searchParams.get("op") ?? "";
    switch (op) {
      case "list":
        return await list(request, deps);
      case "detail":
        return await detail(request, deps);
      case "download":
        return await download(request, deps);
      case "check":
        return await check(request, deps);
      case "submit":
        return await submit(request, deps);
      case "reply":
        return await reply(request, deps);
      case "queue":
        return await queue(request, deps);
      case "clients":
        return await clients(request, deps);
      case "staff-status":
        return await setStatus(request, deps);
      case "staff-ask":
        return await ask(request, deps);
      case "staff-return":
        return await attachReturn(request, deps);
      case "staff-register":
        return await register(request, deps);
      case "staff-unregister":
        return await unregister(request, deps);
      case "staff-client":
        return await createClient2(request, deps);
      default:
        return errorResponse(404, "not_found", "Not found.");
    }
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}

// entry/vat.ts
function GET(request) {
  return vatRoute(request, buildDeps(process.env).deps);
}
function POST(request) {
  return vatRoute(request, buildDeps(process.env).deps);
}
export {
  GET,
  POST
};
