import { esc, formatDateTime, PRODUCTS } from './format.js';

// Staff-only screen: the client list and the add-client form. Pure HTML builders (no browser globals), so they
// run under the Node tests. Everything server-supplied goes through esc().

// Provider names are NEVER written in this file: it is served to everyone, clients included, and the portal must not
// reveal which vendor serves anyone. The names arrive from the staff-only API, so only signed-in staff ever see them.

export const freshForm = () => ({ name: '', product: 'us_sales_tax', provider: '', token: '', providerCompanyId: '', email: '' });

export const freshStaff = () => ({ status: 'idle', clients: [], providers: [], error: '', form: freshForm(), busy: false, formError: '', result: null, syncing: null, notice: null, manage: null, logoVersion: 0 });

function connectionCell(c, providers = []) {
  const product = PRODUCTS[c.product]?.label ?? c.product;
  const provider = providers.find((p) => p.key === c.provider)?.label ?? c.provider;
  const state = c.status !== 'active' ? `<span class="status-chip ended">${esc(c.status)}</span>`
    : c.lastSyncStatus === 'failed' ? '<span class="status-chip overdue">Last refresh failed</span>'
    : c.lastSyncedAt ? `<span class="status-chip complete">Refreshed ${esc(formatDateTime(c.lastSyncedAt))}</span>`
    : '<span class="status-chip upcoming">Not refreshed yet</span>';
  const err = c.lastSyncStatus === 'failed' && c.lastSyncError ? `<div class="staff-error-note">${esc(c.lastSyncError)}</div>` : '';
  return `<div class="staff-conn"><div><strong>${esc(product)}</strong> <span class="muted">via ${esc(provider)}</span></div>${state}${err}</div>`;
}

export function clientsTable(clients, syncing, providers = []) {
  if (!clients.length) return '<div class="empty-state">No clients yet. Add the first one below.</div>';
  const rows = clients.map((cl) => {
    const conns = cl.connections.length ? cl.connections.map((c) => connectionCell(c, providers)).join('') : '<span class="muted">No services set up</span>';
    const actives = cl.connections.filter((c) => c.status === 'active');
    const manage = `<button class="btn-inline" data-action="staff-manage" data-tenant="${esc(cl.id)}">Manage</button>`;
    const buttons = manage + ' ' + actives.map((c) => {
      const what = PRODUCTS[c.product]?.label ?? c.product; // several services: say which one this button refreshes
      const label = actives.length > 1 ? `Refresh ${what}` : 'Refresh now';
      return `<button class="btn-inline" data-action="staff-sync" data-conn="${esc(c.id)}" ${syncing === c.id ? 'disabled' : ''}>${syncing === c.id ? 'Refreshing…' : esc(label)}</button>`;
    }).join(' ');
    return `<tr><td data-label="Client"><strong>${esc(cl.name)}</strong></td><td data-label="Users">${esc(cl.users)}</td><td data-label="Services">${conns}</td><td data-label="">${buttons}</td></tr>`;
  }).join('');
  return `<table class="data"><thead><tr><th>Client</th><th>Users</th><th>Services</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function field(id, label, input, hint = '') {
  return `<label class="field-label" for="${id}">${esc(label)}</label>${input}${hint ? `<p class="otp-note staff-hint">${esc(hint)}</p>` : ''}`;
}

export function resultNote(r) {
  if (!r) return '';
  const inv = { created: `A sign-in has been created for ${r.email}. They can sign in with an emailed code.`, existing: `${r.email} already had a sign-in and now has access to this client.`, failed: `The client was saved, but the sign-in for ${r.email} could not be set up. Add them again from here, or in Supabase.` }[r.invite] ?? '';
  const sync = r.sync?.status === 'succeeded' ? `First refresh done: ${r.sync.registrations} registration(s), ${r.sync.filings} filing(s).`
    : `The first refresh did not complete${r.sync?.error ? ` (${r.sync.error})` : ''}. It will retry in the daily run, or use "Refresh now".`;
  const tone = r.invite === 'failed' || r.sync?.status !== 'succeeded' ? 'form-error' : 'form-info';
  return `<div class="${tone}" role="status"><strong>${esc(r.name)} was added.</strong> ${esc(sync)} ${esc(inv)}</div>`;
}

export function noticeNote(n) {
  return n ? `<div class="${n.tone === 'error' ? 'form-error' : 'form-info'}" role="status">${esc(n.text)}</div>` : '';
}

export const ROLE_LABEL = { owner: 'Owner', member: 'User', accountant: 'Accountant (view only)' };

export function manageCard(st) {
  const m = st.manage;
  if (!m) return '';
  const client = st.clients.find((c) => c.id === m.tenantId);
  if (!client) return '';
  const users = m.status === 'loading' ? '<div class="loading" role="status">Loading…</div>'
    : m.status === 'error' ? `<div class="error-state" role="alert"><p>${esc(m.error)}</p></div>`
    : m.users.length === 0 ? '<div class="empty-state">Nobody has access yet.</div>'
    : `<table class="data"><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody>${m.users.map((u) => `<tr><td data-label="Email">${esc(u.email)}</td><td data-label="Role">${esc(ROLE_LABEL[u.role] ?? u.role)}</td><td data-label=""><button class="btn-inline" data-action="staff-remove-user" data-user="${esc(u.userId)}">Remove access</button></td></tr>`).join('')}</tbody></table>`;
  const roleOptions = Object.entries(ROLE_LABEL).map(([k, label]) => `<option value="${k}" ${k === 'member' ? 'selected' : ''}>${esc(label)}</option>`).join('');
  const logo = client.hasLogo
    ? `<div class="logo-preview"><img src="/api/logo?tenant=${esc(client.id)}&amp;v=${esc(st.logoVersion)}" alt="Current logo"></div><button class="btn-inline" data-action="staff-remove-logo">Remove logo</button>`
    : '<p class="otp-note">No logo yet. Clients see the Taxcart name only.</p>';
  return `<div class="card staff-card" id="manage-card"><div class="card-head"><div class="card-head-left"><div><div class="card-title">Manage ${esc(client.name)}</div><div class="card-sub">Who can sign in to this client, and their logo.</div></div></div><button class="card-link" data-action="staff-manage-close">Close</button></div>
    ${noticeNote(m.notice)}
    ${users}
    <div class="card-body-note"><h2 class="staff-h">Give someone access</h2>
      <form id="user-form" class="staff-form" novalidate>
        <label class="field-label" for="user-email">Email</label><div class="field-box"><input id="user-email" name="email" type="email" inputmode="email" autocomplete="off" required></div>
        <label class="field-label" for="user-role">Role</label><div class="field-box"><select id="user-role" name="role" class="staff-select">${roleOptions}</select></div>
        <p class="otp-note staff-hint">Accountants can look but never manage. They sign in with an emailed code, like everyone else.</p>
        <button class="btn btn-primary staff-submit" type="submit" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Saving…' : 'Give access'}</button>
      </form>
      <h2 class="staff-h">Logo</h2>${logo}
      <label class="field-label" for="logo-file">${client.hasLogo ? 'Replace logo' : 'Upload logo'} (PNG, JPEG or WebP, up to 150 KB)</label>
      <input id="logo-file" class="staff-file" type="file" accept="image/png,image/jpeg,image/webp">
    </div></div>`;
}

export function addClientForm(st) {
  const f = st.form;
  const input = (id, type, value, extra = '') => `<div class="field-box"><input id="${id}" name="${id}" type="${type}" value="${esc(value)}" autocomplete="off" ${extra}></div>`;
  const select = (id, options, value) => `<div class="field-box"><select id="${id}" name="${id}" class="staff-select">${options.map((o) => `<option value="${esc(o.key)}" ${o.key === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`;
  return `<form id="staff-form" class="staff-form" novalidate>
    ${field('name', 'Client name', input('name', 'text', f.name, 'required maxlength="120"'))}
    ${field('product', 'Service', select('product', [{ key: 'us_sales_tax', label: PRODUCTS.us_sales_tax.label }], f.product))}
    ${field('provider', 'Provider', select('provider', st.providers, f.provider || st.providers[0]?.key))}
    ${field('token', "Client's provider API token", input('token', 'password', f.token, 'required spellcheck="false"'), 'Copy it from the provider, paste it here. It is checked first, then stored encrypted. It is never shown again.')}
    ${field('providerCompanyId', "Provider's company ID (optional)", input('providerCompanyId', 'text', f.providerCompanyId, 'maxlength="100"'), "Leave blank unless the provider tells you the token covers several companies.")}
    ${field('email', "First user's email (optional)", input('email', 'email', f.email, 'inputmode="email"'), 'They become this client\'s owner and sign in with an emailed code. You can leave this blank and add them later.')}
    ${st.formError ? `<div class="form-error" role="alert">${esc(st.formError)}</div>` : ''}
    <button class="btn btn-primary staff-submit" type="submit" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Checking the token and saving…' : 'Add client'}</button>
  </form>`;
}

export function staffPage(st) {
  const list = st.status === 'loading' || st.status === 'idle' ? '<div class="loading" role="status">Loading…</div>'
    : st.status === 'error' ? `<div class="error-state" role="alert"><p>${esc(st.error)}</p><button class="btn-inline" data-action="staff-reload">Try again</button></div>`
    : clientsTable(st.clients, st.syncing, st.providers);
  return `<div class="page-head"><div><h1 class="page-title">Clients</h1><p class="page-sub">Staff only. Add a client, check on their data, and refresh it on demand.</p></div></div>
    ${resultNote(st.result)}${noticeNote(st.notice)}
    <div class="card"><div class="card-head"><div class="card-head-left"><div><div class="card-title">All clients</div><div class="card-sub">Each client has their own provider token and sees only their own data.</div></div></div></div>${list}</div>
    ${manageCard(st)}
    <div class="card staff-card"><div class="card-head"><div class="card-head-left"><div><div class="card-title">Add a client</div><div class="card-sub">Needs the client's own API token from their provider account.</div></div></div></div><div class="card-body-note">${addClientForm(st)}</div></div>`;
}
