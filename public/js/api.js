// Small fetch client for the portal's own endpoints. No browser globals are touched at import time,
// so the same file runs in Node tests (a fake fetch is injected).

export class ApiError extends Error {
  constructor(status, code, message, retryAfter = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.data = null; // the full error body, when the server sent one (the VAT upload check uses it)
  }
}

const GENERIC = 'Something went wrong. Please try again.';
const OFFLINE = 'We could not reach the server. Check your connection and try again.';

/**
 * @param {{ fetch?: typeof fetch, onUnauthorized?: () => void }} opts
 */
export function createApi({ fetch: fetchImpl = globalThis.fetch?.bind(globalThis), onUnauthorized = () => {} } = {}) {
  async function call(path, init = {}) {
    let res;
    try {
      res = await fetchImpl(path, { credentials: 'same-origin', ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
    } catch {
      throw new ApiError(0, 'network', OFFLINE);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body: handled below */
    }
    if (res.ok) {
      if (data === null || typeof data !== 'object') throw new ApiError(res.status, 'bad_response', GENERIC);
      return data;
    }
    const retry = Number(res.headers?.get?.('Retry-After'));
    const err = new ApiError(
      res.status,
      typeof data?.error?.code === 'string' ? data.error.code : 'error',
      typeof data?.error?.message === 'string' ? data.error.message : GENERIC,
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
    err.data = data;
    // 401 on a data call means the session is gone. Login-form 401s ("wrong code") are handled by the caller.
    if (res.status === 401 && init.__session !== false) onUnauthorized();
    throw err;
  }

  const post = (path, body, extra = {}) =>
    call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra });

  const qs = (params) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.set(k, String(v));
    return u.toString();
  };

  // A file goes up as raw bytes (not JSON), with its name in a header.
  const file_ = (path, file) =>
    call(path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'file') }, body: file });

  return {
    requestCode: (email) => post('/api/auth/request-code', { email }, { __session: false }),
    verifyCode: (email, code) => post('/api/auth/verify-code', { email, code }, { __session: false }),
    logout: () => post('/api/auth/logout', {}, { __session: false }),
    session: () => call('/api/session'),
    filings: ({ tenant, product, limit = 50, offset = 0 }) => call(`/api/filings?${qs({ tenant, product, limit, offset })}`),
    registrations: ({ tenant, product, limit = 100, offset = 0 }) => call(`/api/registrations?${qs({ tenant, product, limit, offset })}`),
    staffClients: () => call('/api/staff?op=clients'),
    staffCreateClient: (payload) => post('/api/staff?op=create-client', payload),
    staffUsers: (tenant) => call(`/api/staff?${qs({ op: 'users', tenant })}`),
    staffAddUser: (payload) => post('/api/staff?op=add-user', payload),
    staffRemoveUser: (payload) => post('/api/staff?op=remove-user', payload),
    staffSetLogo: (payload) => post('/api/staff?op=logo', payload),
    staffSync: (connectionId) => post('/api/staff?op=sync', { connectionId }),
    // ---- VAT service (one function, chosen by ?op=)
    vatList: (tenant, preview) => call(`/api/vat?${qs({ op: 'list', tenant, preview: preview ? 1 : undefined })}`),
    vatDetail: (id, preview) => call(`/api/vat?${qs({ op: 'detail', id, preview: preview ? 1 : undefined })}`),
    vatDownload: (id, kind) => call(`/api/vat?${qs({ op: 'download', id, kind })}`),
    vatCheck: (params, file) => file_(`/api/vat?${qs({ op: 'check', ...params })}`, file),
    vatSubmit: (params, file) => file_(`/api/vat?${qs({ op: 'submit', ...params })}`, file),
    vatSubmitNil: (params) => post(`/api/vat?${qs({ op: 'submit-nil', ...params })}`, {}),
    vatReply: (id, body, behalf) => post('/api/vat?op=reply', { id, body, ...(behalf ? { behalf: true } : {}) }),
    vatQueue: () => call('/api/vat?op=queue'),
    vatClients: () => call('/api/vat?op=clients'),
    vatSetStatus: (payload) => post('/api/vat?op=staff-status', payload),
    vatAsk: (id, body) => post('/api/vat?op=staff-ask', { id, body }),
    vatAttachReturn: (id, file) => file_(`/api/vat?${qs({ op: 'staff-return', id })}`, file),
    vatRegister: (payload) => post('/api/vat?op=staff-register', payload),
    vatUnregister: (id) => post('/api/vat?op=staff-unregister', { id }),
    vatInvite: (payload) => post('/api/vat?op=staff-invite', payload),
    vatCreateClient: (payload) => post('/api/vat?op=staff-client', payload),
  };
}
