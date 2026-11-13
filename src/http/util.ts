import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './config.ts';

/** An error that maps straight to an HTTP response. Messages are written for end users. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export function jsonResponse(body: unknown, status = 200, extra: { headers?: Record<string, string>; setCookies?: string[] } = {}): Response {
  const headers = new Headers({ ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra.headers });
  for (const c of extra.setCookies ?? []) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(status: number, code: string, message: string, extra: { headers?: Record<string, string>; setCookies?: string[] } = {}): Response {
  return jsonResponse({ error: { code, message } }, status, extra);
}

/** Turn anything thrown inside a handler into a safe response. Unexpected errors never leak detail. */
export function toErrorResponse(err: unknown, log?: (event: string, fields?: Record<string, unknown>) => void): Response {
  if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message);
  log?.('http.unexpected_error', { name: err instanceof Error ? err.name : typeof err });
  return errorResponse(500, 'internal_error', 'Something went wrong. Please try again.');
}

/**
 * CSRF defence for state-changing requests: the browser-supplied Origin must be one of ours.
 * A missing Origin is rejected (fail closed): browsers always send it on cross-site POSTs.
 */
export function requireAllowedOrigin(request: Request, config: AppConfig): void {
  const origin = request.headers.get('origin');
  if (!origin || !config.appOrigins.includes(origin)) {
    throw new HttpError(403, 'forbidden_origin', 'This request was not allowed.');
  }
}

export function requireMethod(request: Request, method: 'GET' | 'POST'): void {
  if (request.method !== method) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
}

/** Reads a small JSON object body. Requires an explicit JSON content type, which plain HTML forms cannot send cross-site. */
export async function readJsonObject(request: Request, maxBytes = 4096): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'unsupported_media_type', 'Send the request as JSON.');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new HttpError(413, 'too_large', 'Request is too large.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'Request is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_input', 'The request body is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_input', 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/** Client address as set by the hosting proxy (Vercel overwrites these headers, so they cannot be spoofed there). */
export function clientIp(request: Request): string {
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first || 'unknown';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_input', 'Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new HttpError(400, 'invalid_input', 'Enter a valid email address.');
  return email;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Constant-time string comparison (hashes first so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Keyed hash for throttle buckets: stable per value, but not reversible to the raw email or IP. */
export function bucketKey(secret: string, kind: string, value: string): string {
  return createHmac('sha256', secret).update(`${kind}|${value}`).digest('hex');
}
