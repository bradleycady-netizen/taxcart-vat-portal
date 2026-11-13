import { createHash } from 'node:crypto';
import { COUNTRIES, SCHEMES, SCHEME_INFO, STATUSES, countryName, defaultDueDate, parsePeriod, periodLabel, recentEndedPeriods, validRegistration, type Frequency, type Scheme, type VatStatus } from '../../vat/config.ts';
import { MAX_UPLOAD_BYTES, checkSalesFile } from '../../vat/validate.ts';
import { LIMITS, type Rule } from '../limits.ts';
import { authenticate, type Authenticated } from '../session.ts';
import type { Deps } from '../types.ts';
import { HttpError, UUID_RE, bucketKey, errorResponse, jsonResponse, normalizeEmail, readJsonObject, requireAllowedOrigin, requireMethod, toErrorResponse } from '../util.ts';

/**
 * The manual VAT service. Clients upload a sales file per scheme and period; Taxcart staff move each return through
 * six statuses, ask questions and attach the finished return. Everything is routed by ?op= through one function.
 *
 * Reading goes through row-level security (userDb), so a client can only ever see their own client's rows and staff see all.
 * Writing uses the service role AFTER this file has checked who is asking and what they are allowed to do.
 */

type Row = Record<string, unknown>;
type Signed = Extract<Authenticated, { ok: true }>;
const BUCKET = 'vat-files';
const NOT_FOUND = () => new HttpError(404, 'not_found', 'Not found.');
const UNAVAILABLE = () => new HttpError(503, 'unavailable', 'We could not complete that right now. Please try again shortly.');

// ------------------------------------------------------------------ shared helpers

async function requireUser(request: Request, deps: Deps): Promise<Signed | Response> {
  const a = await authenticate(request, deps);
  return a.ok ? a : a.response;
}
async function requireStaff(request: Request, deps: Deps): Promise<Signed | Response> {
  const a = await authenticate(request, deps);
  if (!a.ok) return a.response;
  if (!a.user.isStaff) return errorResponse(404, 'not_found', 'Not found.', { setCookies: a.setCookies });
  return a;
}

async function throttle(deps: Deps, kind: string, userId: string, rule: Rule): Promise<void> {
  let allowed: boolean;
  try { allowed = await deps.throttle.hit(bucketKey(deps.config.throttleSecret, kind, userId), rule.limit, rule.windowSeconds); } catch { throw UNAVAILABLE(); }
  if (!allowed) throw new HttpError(429, 'rate_limited', 'Too many requests in a short time. Please wait a while and try again.');
}

async function audit(deps: Deps, entry: Parameters<Deps['audit']['record']>[0]): Promise<void> {
  try { await deps.audit.record(entry); } catch { deps.log('audit.vat_not_recorded'); }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
function uuid(v: unknown, what = 'item'): string {
  const s = str(v);
  if (!UUID_RE.test(s)) throw new HttpError(400, 'invalid_input', `A valid ${what} is required.`);
  return s;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  const s = str(v) as T;
  if (!allowed.includes(s)) throw new HttpError(400, 'invalid_input', `Choose a valid ${what}.`);
  return s;
}
function cleanText(v: unknown, max = 2000): string {
  const s = str(v).replace(/\r\n/g, '\n').trim();
  if (s.length < 1 || s.length > max) throw new HttpError(400, 'invalid_input', `Write a message of 1 to ${max} characters.`);
  return s;
}

const PREPARED = ['return_prepared', 'filed', 'complete'];

/** `staff` false = a client is looking: the finished return is not mentioned until Taxcart has prepared it. */
function mapReturn(r: Row, tenantNames?: Map<string, string>, staff = true): Row {
  const scheme = String(r['scheme']) as Scheme;
  return {
    id: r['id'],
    tenantId: r['tenant_id'],
    ...(tenantNames ? { tenantName: tenantNames.get(String(r['tenant_id'])) ?? '' } : {}),
    scheme,
    schemeLabel: SCHEME_INFO[scheme]?.label ?? scheme,
    country: r['country'],
    countryName: countryName(String(r['country'])),
    periodCode: r['period_code'],
    periodLabel: periodLabel(String(r['period_code'])),
    periodEnd: r['period_end'],
    dueOn: r['due_on'] ?? null,
    status: r['status'],
    awaitingClient: r['awaiting_client'] === true,
    submittedAt: r['submitted_at'],
    updatedAt: r['updated_at'],
    filedAt: r['filed_at'] ?? null,
    upload: r['upload_path'] ? { name: r['upload_name'], bytes: r['upload_bytes'], rows: r['upload_rows'] } : null,
    returnFile: r['return_path'] && (staff || PREPARED.includes(String(r['status']))) ? { name: r['return_name'], bytes: r['return_bytes'] } : null,
  };
}

const RETURN_COLUMNS = 'id,tenant_id,scheme,country,period_code,period_start,period_end,due_on,status,awaiting_client,submitted_at,updated_at,filed_at,upload_path,upload_name,upload_bytes,upload_rows,return_path,return_name,return_bytes';

/** Who may change things for this client: owners and members (not the view-only accountant role), or staff. */
async function requireCanWrite(deps: Deps, a: Signed, tenantId: string): Promise<void> {
  if (a.user.isStaff) return;
  const { data, error } = await deps.serviceDb.from('tenant_members').select('role').eq('tenant_id', tenantId).eq('user_id', a.user.id).maybeSingle();
  if (error) throw new Error('could not check access');
  if (!data) throw NOT_FOUND();
  if ((data as Row)['role'] === 'accountant') throw new HttpError(403, 'read_only', 'Your access to this account is view-only.');
}

/** Reads the whole request body as bytes (a file), refusing anything bigger than the limit. */
async function readFileBody(request: Request, max: number): Promise<Uint8Array> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/octet-stream\b/i.test(type)) throw new HttpError(415, 'unsupported_media_type', 'Send the file as raw data.');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > max + 1024) throw new HttpError(413, 'too_large', 'That file is larger than 4 MB. Please split it by month, or send it to your Taxcart contact.');
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length > max) throw new HttpError(413, 'too_large', 'That file is larger than 4 MB. Please split it by month, or send it to your Taxcart contact.');
  return buf;
}

function cleanFileName(request: Request, fallback: string): string {
  let raw = request.headers.get('x-file-name') ?? '';
  try { raw = decodeURIComponent(raw); } catch { raw = ''; }
  const base = raw.split(/[\\/]/).pop() ?? '';
  const safe = base.replace(/[^A-Za-z0-9._ ()-]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
  return safe || fallback;
}

async function putObject(deps: Deps, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const store = () => deps.serviceDb.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false });
  let r = await store();
  if (r.error && /bucket not found/i.test(r.error.message)) {
    const made = await deps.serviceDb.storage.createBucket(BUCKET, { public: false });
    if (made.error && !/already exists/i.test(made.error.message)) throw new Error('could not create storage');
    r = await store();
  }
  if (r.error) throw new Error('could not store file');
}
async function removeObject(deps: Deps, path: string | null | undefined): Promise<void> {
  if (!path) return;
  try { await deps.serviceDb.storage.from(BUCKET).remove([path]); } catch { deps.log('vat.old_file_not_removed'); }
}

async function loadReturnForStaffOrMember(deps: Deps, a: Signed, id: string): Promise<Row> {
  const { data, error } = await deps.userDb(a.accessToken).from('vat_returns').select(RETURN_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error('could not load return');
  if (!data) throw NOT_FOUND();
  return data as Row;
}

// ------------------------------------------------------------------ client: reading

/** GET ?op=list&tenant=<id>: this client's registrations (with the periods they can upload for) and every return so far. */
async function list(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'GET');
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  const q = new URL(request.url).searchParams;
  const tenant = uuid(q.get('tenant'), 'client');
  const asStaff = a.user.isStaff && q.get('preview') !== '1'; // a staff member previewing a client sees exactly what the client sees
  const db = deps.userDb(a.accessToken);
  const [reg, ret] = await Promise.all([
    db.from('vat_registrations').select('id,scheme,country,frequency,vat_number').eq('tenant_id', tenant).order('scheme').order('country'),
    db.from('vat_returns').select(RETURN_COLUMNS).eq('tenant_id', tenant).order('period_start', { ascending: false }).limit(300),
  ]);
  if (reg.error || ret.error) throw new Error('could not load VAT data');
  const returns = (ret.data ?? []) as Row[];
  const now = deps.now();
  const registrations = ((reg.data ?? []) as Row[]).map((r) => {
    const scheme = String(r['scheme']) as Scheme;
    const frequency = String(r['frequency']) as Frequency;
    const country = String(r['country']);
    return {
      id: r['id'], scheme, schemeLabel: SCHEME_INFO[scheme].label, country, countryName: countryName(country), frequency, vatNumber: r['vat_number'] ?? null,
      periods: recentEndedPeriods(now, frequency, 4).map((p) => {
        const existing = returns.find((x) => x['scheme'] === scheme && x['country'] === country && x['period_code'] === p.code);
        return { code: p.code, label: p.label, start: p.start, end: p.end, dueOn: defaultDueDate(scheme, p), returnId: existing ? existing['id'] : null, status: existing ? existing['status'] : null };
      }),
    };
  });
  // The latest open question on each return that is waiting for the client, so it can be shown right on the card.
  const waiting = returns.filter((r) => r['awaiting_client'] === true).map((r) => String(r['id']));
  const questions = new Map<string, Row>();
  if (waiting.length) {
    const qs = await db.from('vat_events').select('return_id,body,created_at').eq('kind', 'question').in('return_id', waiting).order('created_at', { ascending: true });
    if (qs.error) throw new Error('could not load questions');
    for (const e of (qs.data ?? []) as Row[]) questions.set(String(e['return_id']), { body: e['body'], at: e['created_at'] });
  }
  return jsonResponse({ registrations, returns: returns.map((r) => ({ ...mapReturn(r, undefined, asStaff), question: questions.get(String(r['id'])) ?? null })) }, 200, { setCookies: a.setCookies });
}

/** GET ?op=detail&id=<return>: one return with its history and conversation. */
async function detail(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'GET');
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  const dq = new URL(request.url).searchParams;
  const id = uuid(dq.get('id'), 'return');
  const asStaff = a.user.isStaff && dq.get('preview') !== '1';
  const row = await loadReturnForStaffOrMember(deps, a, id);
  const ev = await deps.userDb(a.accessToken).from('vat_events').select('id,actor_side,kind,to_status,body,created_at').eq('return_id', id).order('created_at', { ascending: true }).limit(500);
  if (ev.error) throw new Error('could not load history');
  const names = new Map<string, string>();
  if (asStaff) {
    const t = await deps.serviceDb.from('tenants').select('id,name').eq('id', String(row['tenant_id'])).maybeSingle();
    if (t.data) names.set(String((t.data as Row)['id']), String((t.data as Row)['name']));
  }
  const summary = asStaff ? await deps.serviceDb.from('vat_returns').select('upload_summary').eq('id', id).maybeSingle() : null;
  return jsonResponse(
    {
      return: mapReturn(row, asStaff ? names : undefined, asStaff),
      ...(summary?.data ? { uploadSummary: (summary.data as Row)['upload_summary'] ?? null } : {}),
      events: ((ev.data ?? []) as Row[]).map((e) => ({ id: e['id'], side: e['actor_side'], kind: e['kind'], status: e['to_status'] ?? null, body: e['body'] ?? null, at: e['created_at'] })),
    },
    200,
    { setCookies: a.setCookies },
  );
}

/** GET ?op=download&id=<return>&kind=upload|return: a link that works for one minute. */
async function download(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'GET');
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  await throttle(deps, 'download', a.user.id, LIMITS.download.perUser);
  const q = new URL(request.url).searchParams;
  const id = uuid(q.get('id'), 'return');
  const kind = oneOf(q.get('kind'), ['upload', 'return'] as const, 'file');
  const row = await loadReturnForStaffOrMember(deps, a, id);
  const path = str(kind === 'upload' ? row['upload_path'] : row['return_path']);
  const name = str(kind === 'upload' ? row['upload_name'] : row['return_name']) || 'file';
  if (!path) throw NOT_FOUND();
  // Clients only get the finished return once Taxcart has prepared it.
  if (kind === 'return' && !a.user.isStaff && !['return_prepared', 'filed', 'complete'].includes(String(row['status']))) throw NOT_FOUND();
  const signed = await deps.serviceDb.storage.from(BUCKET).createSignedUrl(path, 60, { download: name });
  if (signed.error || !signed.data?.signedUrl) throw new Error('could not sign link');
  await audit(deps, { tenantId: String(row['tenant_id']), actorId: a.user.id, action: 'vat.download', target: `vat_return:${id}`, detail: { kind } });
  return jsonResponse({ url: signed.data.signedUrl, name }, 200, { setCookies: a.setCookies });
}

// ------------------------------------------------------------------ client: uploading

async function readUploadContext(request: Request, deps: Deps, a: Signed) {
  requireAllowedOrigin(request, deps.config);
  const q = new URL(request.url).searchParams;
  const tenant = uuid(q.get('tenant'), 'client');
  const scheme = oneOf(q.get('scheme'), SCHEMES, 'scheme');
  const country = str(q.get('country')).toUpperCase();
  if (!(country in COUNTRIES)) throw new HttpError(400, 'invalid_input', 'Choose a valid country.');
  await requireCanWrite(deps, a, tenant);
  const reg = await deps.serviceDb.from('vat_registrations').select('id,frequency').eq('tenant_id', tenant).eq('scheme', scheme).eq('country', country).maybeSingle();
  if (reg.error) throw new Error('could not check registration');
  if (!reg.data) throw new HttpError(400, 'not_registered', 'That filing is not set up for your account. Please contact your Taxcart representative.');
  const frequency = String((reg.data as Row)['frequency']) as Frequency;
  const period = parsePeriod(str(q.get('period')), frequency);
  if (!period) throw new HttpError(400, 'invalid_input', 'Choose a valid period.');
  if (period.end >= deps.now().toISOString().slice(0, 10)) throw new HttpError(400, 'period_open', 'That period has not finished yet. You can upload once it has ended.');
  // Staff can submit on a client's behalf (the "view as client" preview). It is recorded as the client's own action, with the staff member in the audit trail.
  const behalf = a.user.isStaff && q.get('behalf') === '1';
  return { tenant, scheme, country, period, behalf, registrationId: String((reg.data as Row)['id']) };
}

/** POST ?op=check: the same checks as submit, but nothing is saved. Body: the raw file. */
async function check(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'POST');
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  const ctx = await readUploadContext(request, deps, a);
  await throttle(deps, 'vat-upload', a.user.id, LIMITS.vatUpload.perUser);
  const bytes = await readFileBody(request, MAX_UPLOAD_BYTES);
  const result = checkSalesFile(cleanFileName(request, 'file'), bytes, { scheme: ctx.scheme, period: ctx.period });
  return jsonResponse({ result }, 200, { setCookies: a.setCookies });
}

/** POST ?op=submit: checks the file again, stores it privately and records the return as Submitted. */
async function submit(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'POST');
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  const ctx = await readUploadContext(request, deps, a);
  await throttle(deps, 'vat-upload', a.user.id, LIMITS.vatUpload.perUser);
  const bytes = await readFileBody(request, MAX_UPLOAD_BYTES);
  const fileName = cleanFileName(request, 'sales-file');
  const result = checkSalesFile(fileName, bytes, { scheme: ctx.scheme, period: ctx.period });
  if (!result.ok || !result.summary) return jsonResponse({ result }, 422, { setCookies: a.setCookies });

  const existing = await deps.serviceDb.from('vat_returns').select('id,status,upload_path').eq('tenant_id', ctx.tenant).eq('scheme', ctx.scheme).eq('country', ctx.country).eq('period_code', ctx.period.code).maybeSingle();
  if (existing.error) throw new Error('could not check existing return');
  const prior = existing.data as Row | null;
  if (prior && prior['status'] !== 'submitted') throw new HttpError(409, 'already_received', 'Taxcart has already started on this return. Please send any changes as a message on the return instead.');

  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const ext = result.fileType === 'xlsx' ? 'xlsx' : 'csv';
  const returnId = prior ? String(prior['id']) : crypto.randomUUID();
  const path = `${ctx.tenant}/${returnId}/upload-${digest}.${ext}`;
  await putObject(deps, path, bytes, ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv');

  const fields = {
    upload_path: path, upload_name: fileName, upload_bytes: bytes.length, upload_rows: result.summary.rows,
    upload_summary: { summary: result.summary, warnings: result.warnings },
    submitted_by: a.user.id, submitted_at: deps.now().toISOString(), updated_at: deps.now().toISOString(),
  };
  if (prior) {
    const up = await deps.serviceDb.from('vat_returns').update(fields).eq('id', returnId);
    if (up.error) { await removeObject(deps, path); throw new Error('could not update return'); }
    if (prior['upload_path'] !== path) await removeObject(deps, str(prior['upload_path']));
  } else {
    const ins = await deps.serviceDb.from('vat_returns').insert({
      id: returnId, tenant_id: ctx.tenant, registration_id: ctx.registrationId, scheme: ctx.scheme, country: ctx.country,
      period_code: ctx.period.code, period_start: ctx.period.start, period_end: ctx.period.end, due_on: defaultDueDate(ctx.scheme, ctx.period), status: 'submitted', ...fields,
    });
    if (ins.error) {
      await removeObject(deps, path);
      if (ins.error.code === '23505') throw new HttpError(409, 'already_received', 'A file for that period has just been submitted. Please refresh the page.');
      throw new Error('could not save return');
    }
  }
  await deps.serviceDb.from('vat_events').insert({ return_id: returnId, tenant_id: ctx.tenant, actor_id: a.user.id, actor_side: a.user.isStaff && !ctx.behalf ? 'staff' : 'client', kind: prior ? 'file_replaced' : 'submitted', body: fileName });
  await audit(deps, { tenantId: ctx.tenant, actorId: a.user.id, action: prior ? 'vat.file_replaced' : 'vat.submitted', target: `vat_return:${returnId}`, detail: { scheme: ctx.scheme, country: ctx.country, period: ctx.period.code, rows: result.summary.rows, ...(ctx.behalf ? { onBehalfOfClient: true } : {}) } });
  return jsonResponse({ id: returnId, replaced: Boolean(prior), result }, prior ? 200 : 201, { setCookies: a.setCookies });
}

/** POST ?op=reply {id, body}: the client answers a question or adds a note. */
async function reply(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'POST');
  requireAllowedOrigin(request, deps.config);
  const a = await requireUser(request, deps);
  if (a instanceof Response) return a;
  await throttle(deps, 'vat-write', a.user.id, LIMITS.vatWrite.perUser);
  const body = await readJsonObject(request, 8192);
  const id = uuid(body['id'], 'return');
  const text = cleanText(body['body']);
  const row = await loadReturnForStaffOrMember(deps, a, id);
  const tenant = String(row['tenant_id']);
  await requireCanWrite(deps, a, tenant);
  const side = a.user.isStaff && body['behalf'] !== true ? 'staff' : 'client';
  const ins = await deps.serviceDb.from('vat_events').insert({ return_id: id, tenant_id: tenant, actor_id: a.user.id, actor_side: side, kind: 'reply', body: text });
  if (ins.error) throw new Error('could not save reply');
  if (a.user.isStaff && side === 'client') await audit(deps, { tenantId: tenant, actorId: a.user.id, action: 'vat.reply_on_behalf', target: `vat_return:${id}` });
  if (side === 'client') await deps.serviceDb.from('vat_returns').update({ awaiting_client: false, updated_at: deps.now().toISOString() }).eq('id', id);
  return jsonResponse({ ok: true }, 201, { setCookies: a.setCookies });
}

// ------------------------------------------------------------------ staff

/** GET ?op=queue: every return for every client, plus counts. The staff page sorts and filters it. */
async function queue(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'GET');
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  const [r, t] = await Promise.all([
    deps.serviceDb.from('vat_returns').select(RETURN_COLUMNS).order('due_on', { ascending: true, nullsFirst: false }).limit(1000),
    deps.serviceDb.from('tenants').select('id,name'),
  ]);
  if (r.error || t.error) throw new Error('could not load queue');
  const names = new Map(((t.data ?? []) as Row[]).map((x) => [String(x['id']), String(x['name'])]));
  return jsonResponse({ returns: ((r.data ?? []) as Row[]).map((x) => mapReturn(x, names)) }, 200, { setCookies: s.setCookies });
}

/** GET ?op=clients: every client with the filings they are registered for, for the staff Clients and Countries pages. */
async function clients(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'GET');
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  const [t, r, m] = await Promise.all([
    deps.serviceDb.from('tenants').select('id,name').order('name', { ascending: true }),
    deps.serviceDb.from('vat_registrations').select('id,tenant_id,scheme,country,frequency,vat_number').order('country'),
    deps.serviceDb.from('tenant_members').select('tenant_id'),
  ]);
  if (t.error || r.error || m.error) throw new Error('could not load clients');
  const regs = (r.data ?? []) as Row[];
  const members = (m.data ?? []) as Row[];
  return jsonResponse(
    {
      clients: ((t.data ?? []) as Row[]).map((c) => ({
        id: c['id'], name: c['name'], users: members.filter((x) => x['tenant_id'] === c['id']).length,
        registrations: regs.filter((x) => x['tenant_id'] === c['id']).map((x) => ({ id: x['id'], scheme: x['scheme'], schemeLabel: SCHEME_INFO[String(x['scheme']) as Scheme]?.label, country: x['country'], countryName: countryName(String(x['country'])), frequency: x['frequency'], vatNumber: x['vat_number'] ?? null })),
      })),
      countries: Object.entries(COUNTRIES).map(([code, name]) => ({ code, name })),
      schemes: SCHEMES.map((k) => ({ key: k, label: SCHEME_INFO[k].label, frequencies: SCHEME_INFO[k].frequencies })),
    },
    200,
    { setCookies: s.setCookies },
  );
}

/** POST ?op=staff-status {id, status, dueOn?, note?}: move a return along (or back, to correct a slip). */
async function setStatus(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'POST');
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, 'vat-staff', s.user.id, LIMITS.vatStaff.perUser);
  const body = await readJsonObject(request, 8192);
  const id = uuid(body['id'], 'return');
  const status = oneOf(body['status'], STATUSES, 'status') as VatStatus;
  const row = await deps.serviceDb.from('vat_returns').select('id,tenant_id,status,due_on,return_path').eq('id', id).maybeSingle();
  if (row.error) throw new Error('could not load return');
  if (!row.data) throw NOT_FOUND();
  const cur = row.data as Row;
  if ((status === 'filed' || status === 'complete') && !cur['return_path']) throw new HttpError(400, 'return_missing', 'Attach the return PDF before marking it Filed or Complete.');
  const update: Row = { status, updated_at: deps.now().toISOString() };
  if (status === 'filed' && cur['status'] !== 'filed' && cur['status'] !== 'complete') update['filed_at'] = deps.now().toISOString();
  let dueChanged = false;
  if (body['dueOn'] !== undefined && body['dueOn'] !== null && body['dueOn'] !== '') {
    const due = str(body['dueOn']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due))) throw new HttpError(400, 'invalid_input', 'Enter the due date as a real date.');
    if (due !== cur['due_on']) { update['due_on'] = due; dueChanged = true; }
  }
  const note = body['note'] ? cleanText(body['note']) : null;
  const up = await deps.serviceDb.from('vat_returns').update(update).eq('id', id);
  if (up.error) throw new Error('could not update return');
  const tenant = String(cur['tenant_id']);
  const events: Row[] = [];
  if (status !== cur['status']) events.push({ return_id: id, tenant_id: tenant, actor_id: s.user.id, actor_side: 'staff', kind: 'status', to_status: status, body: note });
  if (dueChanged) events.push({ return_id: id, tenant_id: tenant, actor_id: s.user.id, actor_side: 'staff', kind: 'due_changed', body: String(update['due_on']) });
  if (events.length) await deps.serviceDb.from('vat_events').insert(events);
  await audit(deps, { tenantId: tenant, actorId: s.user.id, action: 'vat.status', target: `vat_return:${id}`, detail: { from: cur['status'], to: status } });
  return jsonResponse({ ok: true }, 200, { setCookies: s.setCookies });
}

/** POST ?op=staff-ask {id, body}: a question for the client. The return shows "waiting on client" until they reply. */
async function ask(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'POST');
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, 'vat-staff', s.user.id, LIMITS.vatStaff.perUser);
  const body = await readJsonObject(request, 8192);
  const id = uuid(body['id'], 'return');
  const text = cleanText(body['body']);
  const row = await deps.serviceDb.from('vat_returns').select('tenant_id').eq('id', id).maybeSingle();
  if (row.error) throw new Error('could not load return');
  if (!row.data) throw NOT_FOUND();
  const ins = await deps.serviceDb.from('vat_events').insert({ return_id: id, tenant_id: String((row.data as Row)['tenant_id']), actor_id: s.user.id, actor_side: 'staff', kind: 'question', body: text });
  if (ins.error) throw new Error('could not save question');
  await deps.serviceDb.from('vat_returns').update({ awaiting_client: true, updated_at: deps.now().toISOString() }).eq('id', id);
  return jsonResponse({ ok: true }, 201, { setCookies: s.setCookies });
}

/** POST ?op=staff-return&id=<return>: attach (or replace) the finished return PDF. Body: the raw PDF. */
async function attachReturn(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'POST');
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, 'vat-staff', s.user.id, LIMITS.vatStaff.perUser);
  const id = uuid(new URL(request.url).searchParams.get('id'), 'return');
  const bytes = await readFileBody(request, MAX_UPLOAD_BYTES);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
  if (!head.startsWith('%PDF-')) throw new HttpError(400, 'file_type', 'Please attach a PDF file.');
  const row = await deps.serviceDb.from('vat_returns').select('tenant_id,return_path').eq('id', id).maybeSingle();
  if (row.error) throw new Error('could not load return');
  if (!row.data) throw NOT_FOUND();
  const cur = row.data as Row;
  const tenant = String(cur['tenant_id']);
  const name = cleanFileName(request, 'vat-return.pdf').replace(/(\.pdf)?$/i, '.pdf');
  const path = `${tenant}/${id}/return-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.pdf`;
  if (path !== cur['return_path']) await putObject(deps, path, bytes, 'application/pdf');
  const up = await deps.serviceDb.from('vat_returns').update({ return_path: path, return_name: name, return_bytes: bytes.length, updated_at: deps.now().toISOString() }).eq('id', id);
  if (up.error) { if (path !== cur['return_path']) await removeObject(deps, path); throw new Error('could not save return file'); }
  if (cur['return_path'] && cur['return_path'] !== path) await removeObject(deps, str(cur['return_path']));
  await deps.serviceDb.from('vat_events').insert({ return_id: id, tenant_id: tenant, actor_id: s.user.id, actor_side: 'staff', kind: 'return_attached', body: name });
  await audit(deps, { tenantId: tenant, actorId: s.user.id, action: 'vat.return_attached', target: `vat_return:${id}` });
  return jsonResponse({ ok: true }, 201, { setCookies: s.setCookies });
}

/** POST ?op=staff-register {tenantId, scheme, country, frequency, vatNumber?}: set up a filing for a client. */
async function register(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'POST');
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, 'vat-staff', s.user.id, LIMITS.vatStaff.perUser);
  const body = await readJsonObject(request, 4096);
  const tenant = uuid(body['tenantId'], 'client');
  const scheme = oneOf(body['scheme'], SCHEMES, 'scheme');
  const country = str(body['country']).toUpperCase();
  const frequency = oneOf(body['frequency'], ['monthly', 'quarterly', 'annual'] as const, 'frequency');
  const problem = validRegistration(scheme, country, frequency);
  if (problem) throw new HttpError(400, 'invalid_input', problem);
  const vat = str(body['vatNumber']).trim().toUpperCase();
  if (vat && !/^[A-Z0-9 ]{4,40}$/.test(vat)) throw new HttpError(400, 'invalid_input', 'The VAT number can only contain letters and numbers.');
  const t = await deps.serviceDb.from('tenants').select('id').eq('id', tenant).maybeSingle();
  if (t.error) throw new Error('could not check client');
  if (!t.data) throw NOT_FOUND();
  const ins = await deps.serviceDb.from('vat_registrations').insert({ tenant_id: tenant, scheme, country, frequency, vat_number: vat || null });
  if (ins.error) {
    if (ins.error.code === '23505') throw new HttpError(409, 'exists', 'That filing is already set up for this client.');
    throw new Error('could not save registration');
  }
  await audit(deps, { tenantId: tenant, actorId: s.user.id, action: 'vat.registration_added', detail: { scheme, country, frequency } });
  return jsonResponse({ ok: true }, 201, { setCookies: s.setCookies });
}

/** POST ?op=staff-unregister {id}: remove a filing setup (returns already submitted are kept). */
async function unregister(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'POST');
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, 'vat-staff', s.user.id, LIMITS.vatStaff.perUser);
  const id = uuid((await readJsonObject(request, 2048))['id'], 'filing');
  const del = await deps.serviceDb.from('vat_registrations').delete().eq('id', id);
  if (del.error) throw new Error('could not remove registration');
  await audit(deps, { actorId: s.user.id, action: 'vat.registration_removed', target: `vat_registration:${id}` });
  return jsonResponse({ ok: true }, 200, { setCookies: s.setCookies });
}

/** POST ?op=staff-client {name, email?}: create a client for the VAT service (and invite their first person). */
async function createClient(request: Request, deps: Deps): Promise<Response> {
  requireMethod(request, 'POST');
  requireAllowedOrigin(request, deps.config);
  const s = await requireStaff(request, deps);
  if (s instanceof Response) return s;
  await throttle(deps, 'vat-staff', s.user.id, LIMITS.vatStaff.perUser);
  const body = await readJsonObject(request, 4096);
  const name = str(body['name']).trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) throw new HttpError(400, 'invalid_input', "Enter the client's name (2 to 120 characters).");
  const email = body['email'] ? normalizeEmail(body['email']) : null;
  const t = await deps.serviceDb.from('tenants').insert({ name }).select('id').single();
  const tenantId = (t.data as Row | null)?.['id'];
  if (t.error || typeof tenantId !== 'string') throw new Error('could not create client');
  let invite: 'created' | 'existing' | 'failed' | null = null;
  if (email) {
    const u = await deps.auth.ensureUser(email);
    if (u) {
      const link = await deps.serviceDb.from('tenant_members').insert({ tenant_id: tenantId, user_id: u.id, role: 'owner' });
      invite = link.error ? 'failed' : u.created ? 'created' : 'existing';
    } else invite = 'failed';
  }
  await audit(deps, { tenantId, actorId: s.user.id, action: 'vat.client_created', target: `tenant:${tenantId}`, detail: { invited: invite } });
  return jsonResponse({ client: { id: tenantId, name }, invite }, 201, { setCookies: s.setCookies });
}

// ------------------------------------------------------------------ router

export async function vatRoute(request: Request, deps: Deps): Promise<Response> {
  try {
    const op = new URL(request.url).searchParams.get('op') ?? '';
    switch (op) {
      case 'list': return await list(request, deps);
      case 'detail': return await detail(request, deps);
      case 'download': return await download(request, deps);
      case 'check': return await check(request, deps);
      case 'submit': return await submit(request, deps);
      case 'reply': return await reply(request, deps);
      case 'queue': return await queue(request, deps);
      case 'clients': return await clients(request, deps);
      case 'staff-status': return await setStatus(request, deps);
      case 'staff-ask': return await ask(request, deps);
      case 'staff-return': return await attachReturn(request, deps);
      case 'staff-register': return await register(request, deps);
      case 'staff-unregister': return await unregister(request, deps);
      case 'staff-client': return await createClient(request, deps);
      default: return errorResponse(404, 'not_found', 'Not found.');
    }
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
