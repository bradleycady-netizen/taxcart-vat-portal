import { authenticate } from '../session.ts';
import type { Deps } from '../types.ts';
import { HttpError, UUID_RE, errorResponse, toErrorResponse } from '../util.ts';

/** A client's logo, served to people who belong to that client (and staff). Row-level security does the checking. */

export const MAX_LOGO_BYTES = 150_000;

/** PNG, JPEG or WebP only, judged by the file's own first bytes (the declared type is not trusted). SVG is refused: it can carry scripts. */
export function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (bytes.length > 12 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytes.length > 12 && starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length > 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** GET /api/logo?tenant=<id> */
export async function getLogo(request: Request, deps: Deps): Promise<Response> {
  try {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
    const a = await authenticate(request, deps);
    if (!a.ok) return a.response;
    const tenant = new URL(request.url).searchParams.get('tenant') ?? '';
    if (!UUID_RE.test(tenant)) throw new HttpError(400, 'invalid_input', 'A valid client is required.');

    const { data, error } = await deps.userDb(a.accessToken).from('tenant_logos').select('content_type,data_b64').eq('tenant_id', tenant).maybeSingle();
    if (error) throw new Error('could not load logo');
    const row = data as { content_type?: unknown; data_b64?: unknown } | null;
    if (!row || typeof row.data_b64 !== 'string' || typeof row.content_type !== 'string') return errorResponse(404, 'not_found', 'Not found.', { setCookies: a.setCookies });

    const bytes = Buffer.from(row.data_b64, 'base64');
    const type = sniffImageType(bytes);
    if (!type) return errorResponse(404, 'not_found', 'Not found.', { setCookies: a.setCookies });
    const headers = new Headers({
      'Content-Type': type,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Content-Length': String(bytes.length),
    });
    for (const c of a.setCookies) headers.append('Set-Cookie', c);
    return new Response(bytes, { status: 200, headers });
  } catch (err) {
    return toErrorResponse(err, deps.log);
  }
}
