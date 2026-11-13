import { createApi } from './api.js';
import { ICONS } from './icons.js';
import { staffPage, freshStaff, freshForm } from './staff.js';
import { esc, PRODUCTS, syncBanner, emptyState, errorState, filingsTable, registrationsTable, overview, nexusPage, pager } from './format.js';

const root = document.getElementById('app');
const PAGE = 25;

const freshLogin = (info = '') => ({ step: 'email', email: '', busy: false, error: '', info });
const emptyData = (status = 'loading') => ({ status, filings: null, registrations: null, sync: null, page: null, error: '' });

const state = {
  screen: 'boot', // boot | login | app
  login: freshLogin(),
  session: null,
  tenantId: null,
  product: null,
  view: 'overview', // overview | filings | registrations | nexus
  offset: 0,
  data: emptyData('idle'),
  staff: freshStaff(),
};
let token = 0; // guards against an older response overwriting a newer screen

const api = createApi({
  onUnauthorized: () => {
    if (state.screen === 'app') { state.session = null; state.login = freshLogin('Your session has ended. Please sign in again.'); setScreen('login'); }
  },
});

function setScreen(screen) { state.screen = screen; render(); }
const resetData = () => { state.data = emptyData('loading'); };

/** Bar widths are set from script (an inline style attribute would be blocked by the Content-Security-Policy). */
function applyWidths() {
  for (const el of root.querySelectorAll('[data-w]')) el.style.width = `${Number(el.dataset.w) || 0}%`;
}

const brand = (tag, dark = false) => `<div class="brand"><div class="brand-mark${dark ? ' dark' : ''}">${ICONS.mark}</div><span class="brand-name">Taxcart</span>${tag ? `<span class="brand-tag">${esc(tag)}</span>` : ''}</div>`;

/* ---------------------------------------------------------------- login */
function renderLogin() {
  const l = state.login;
  const err = l.error ? `<div class="form-error" role="alert">${esc(l.error)}</div>` : '';
  const info = l.info ? `<div class="form-info" role="status">${esc(l.info)}</div>` : '';
  const emailStep = l.step === 'email';
  const form = emailStep
    ? `<form id="email-form" novalidate>
         <label class="field-label" for="email">Email</label>
         <div class="field-box">${ICONS.mail}<input id="email" name="email" type="email" inputmode="email" autocomplete="username" placeholder="you@company.com" value="${esc(l.email)}" required autofocus></div>
         ${err}${info}
         <button class="btn btn-primary" type="submit" ${l.busy ? 'disabled' : ''}>${l.busy ? 'Sending…' : 'Send code'}</button>
         <p class="otp-note">Access is by invitation. We will email a one-time code to the address on file.</p>
       </form>`
    : `<form id="code-form" novalidate>
         <label class="field-label" for="code">Sign-in code</label>
         <div class="field-box">${ICONS.key}<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" placeholder="123456" required autofocus></div>
         ${err}${info}
         <button class="btn btn-primary" type="submit" ${l.busy ? 'disabled' : ''}>${l.busy ? 'Checking…' : 'Sign in'}</button>
         <p class="otp-note">If ${esc(l.email)} is registered, a code is on its way. It expires in a few minutes.</p>
         <button class="btn btn-ghost" type="button" data-action="login-back">Use a different email</button>
       </form>`;
  const stat = (n, label) => `<div><div class="side-stat-num">${esc(n)}</div><div class="side-stat-label">${esc(label)}</div></div>`;
  return `<div class="login-wrap">
    <div class="login-side">
      <div class="login-side-top">${brand('')}</div>
      <div class="login-hero-figure"><div class="login-hero-num">Sales tax,<br>handled.</div><div class="login-hero-label">Your filings, registrations and documents in one place, kept up to date for you.</div></div>
      <div class="login-side-bottom">${stat('Filings', 'Status and due dates')}${stat('Registrations', 'Numbers and frequencies')}${stat('Documents', 'Returns on file')}</div>
    </div>
    <main class="login-form-side"><div class="login-form">
      <div class="login-form-brand">${brand('', true)}</div>
      <h1>${emailStep ? 'Sign in' : 'Check your email'}</h1>
      <div class="sub">${emailStep ? 'Enter your work email and we will send a one-time code. No password to remember.' : 'Enter the code we sent you.'}</div>
      ${form}
    </div></main>
  </div>`;
}

/* ---------------------------------------------------------------- app shell */
function currentTenant() { return state.session?.tenants.find((t) => t.id === state.tenantId) ?? null; }

function renderShell() {
  const s = state.session;
  const tenant = currentTenant();
  const isStaff = s.user.isStaff === true;
  const staffNav = isStaff ? `<button class="nav-item ${state.view === 'staff' ? 'active' : ''}" data-action="nav" data-view="staff">${ICONS.key}<span>Clients (staff)</span></button>` : '';
  if (isStaff && state.view === 'staff' && (!tenant || tenant.products.length === 0)) {
    return `<div class="shell"><aside class="sidebar">${brand('Staff')}<nav>${staffNav}</nav><div class="sidebar-footer"><div class="viewer-label">${esc(s.user.email)}</div><button class="switch-btn" data-action="logout">${ICONS.logout}<span>Sign out</span></button></div></aside>
      <main class="main" id="main" tabindex="-1">${renderMain()}</main></div>`;
  }
  if (!tenant || tenant.products.length === 0) {
    const msg = !tenant ? 'No company is linked to this login yet. Please contact your Taxcart representative.' : 'No services are set up for your company yet. Please contact your Taxcart representative.';
    return `<div class="shell"><aside class="sidebar">${brand('')}<div class="sidebar-footer"><button class="switch-btn" data-action="logout">${ICONS.logout}<span>Sign out</span></button></div></aside>
      <main class="main"><h1 class="page-title">Welcome</h1>${emptyState(msg)}</main></div>`;
  }
  const meta = PRODUCTS[state.product] ?? { label: state.product, desc: '', tag: '', cls: 'us' };
  const tenantPicker = s.tenants.length > 1
    ? `<label class="visually-hidden" for="tenant">Company</label><select id="tenant" class="filter-select side-select">${s.tenants.map((t) => `<option value="${esc(t.id)}" ${t.id === state.tenantId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`
    : '';
  const switcher = tenant.products.length > 1
    ? `<div class="product-switch" role="group" aria-label="Service">${tenant.products.map((p) => {
        const m = PRODUCTS[p.product] ?? { label: p.product, desc: '', cls: 'us' };
        const active = p.product === state.product;
        return `<button class="product-option ${active ? 'active' : ''}" data-action="product" data-product="${esc(p.product)}" aria-pressed="${active}">
          <span class="product-icon ${m.cls}">${m.cls === 'vat' ? ICONS.globe : ICONS.flagUS}</span>
          <span class="product-text"><span class="product-name">${esc(m.label)}</span><span class="product-desc">${esc(m.desc)}</span></span>
          ${active ? `<span class="product-check">${ICONS.checkSmall}</span>` : ''}</button>`;
      }).join('')}</div>`
    : '';
  const nav = (key, label, icon) => `<button class="nav-item ${state.view === key ? 'active' : ''}" data-action="nav" data-view="${key}">${icon}<span>${label}</span></button>`;
  const navItems = [nav('overview', 'Dashboard', ICONS.dashboard), nav('filings', 'Filings', ICONS.filings), state.product === 'us_sales_tax' ? nav('nexus', 'Nexus tracker', ICONS.nexus) : '', nav('registrations', 'Registrations', ICONS.registrations)].join('');
  return `<div class="shell">
    <aside class="sidebar">${brand(tenant.products.length > 1 ? '' : meta.tag)}${tenant.hasLogo ? `<div class="client-logo-wrap"><img class="client-logo" src="/api/logo?tenant=${esc(tenant.id)}" alt="${esc(tenant.name)} logo"></div>` : ''}${tenantPicker}${switcher}
      <nav>${navItems}${staffNav}</nav>
      <div class="sidebar-footer">
        <div class="viewer-company">${esc(tenant.name)}</div><div class="viewer-label">${esc(s.user.email)}</div>
        <button class="switch-btn" data-action="logout">${ICONS.logout}<span>Sign out</span></button>
      </div>
    </aside>
    <main class="main" id="main" tabindex="-1">${renderMain()}</main>
  </div>`;
}

const TITLES = { staff: 'Clients', overview: 'Dashboard', filings: 'Filings', registrations: 'Registrations', nexus: 'Nexus tracker' };
const SUBTITLES = {
  us_sales_tax: { overview: 'Overview of your US sales tax filings and registrations.', filings: 'Your US sales tax returns.', registrations: 'Where you are registered to collect sales tax.', nexus: 'Where your sales may require you to register.' },
  eu_vat: { overview: 'Overview of your VAT returns and registrations.', filings: 'Your VAT returns.', registrations: 'Where you are registered for VAT.', nexus: '' },
};

function renderMain() {
  if (state.view === 'staff') return staffPage(state.staff);
  const d = state.data;
  const tenant = currentTenant();
  const actions = state.view === 'filings' && tenant && state.product
    ? `<div class="page-actions"><a class="btn-inline btn-link" href="/api/filings?format=csv&tenant=${encodeURIComponent(tenant.id)}&product=${encodeURIComponent(state.product)}" download>Export to CSV</a></div>` : '';
  const head = `<div class="page-head"><div><h1 class="page-title">${TITLES[state.view]}</h1><p class="page-sub">${esc(SUBTITLES[state.product]?.[state.view] ?? '')}</p></div>${actions}</div>`;
  if (state.view === 'nexus') return head + nexusPage();
  if (d.status === 'error') return head + errorState(d.error);
  const missing = state.view === 'registrations' ? d.registrations === null : d.filings === null || (state.view === 'overview' && d.registrations === null);
  if (d.status === 'loading' || d.status === 'idle' || (d.status === 'ready' && missing)) return `${head}<div class="loading" role="status">Loading…</div>`;
  const banner = syncBanner(d.sync);
  if (state.view === 'registrations') return head + banner + registrationsTable(d.registrations) + pager(d.page);
  if (state.view === 'filings') return head + banner + filingsTable(d.filings, state.product) + pager(d.page);
  return head + banner + overview(d.filings, d.registrations, state.product);
}

/* ---------------------------------------------------------------- data loading */
async function load() {
  const my = ++token;
  const tenant = currentTenant();
  if (!tenant || !state.product || state.view === 'nexus' || state.view === 'staff') return;
  state.data = { ...state.data, status: 'loading' };
  paintMain();
  const q = { tenant: tenant.id, product: state.product };
  try {
    if (state.view === 'registrations') {
      const r = await api.registrations({ ...q, limit: PAGE, offset: state.offset });
      if (my !== token) return;
      state.data = { status: 'ready', registrations: r.registrations, filings: null, sync: r.sync, page: r.page, error: '' };
    } else if (state.view === 'overview') {
      const [f, r] = await Promise.all([api.filings({ ...q, limit: 50, offset: 0 }), api.registrations({ ...q, limit: 100, offset: 0 })]);
      if (my !== token) return;
      state.data = { status: 'ready', filings: f.filings, registrations: r.registrations, sync: f.sync, page: null, error: '' };
    } else {
      const r = await api.filings({ ...q, limit: PAGE, offset: state.offset });
      if (my !== token) return;
      state.data = { status: 'ready', filings: r.filings, registrations: null, sync: r.sync, page: r.page, error: '' };
    }
  } catch (e) {
    if (my !== token || state.screen !== 'app') return;
    state.data = { ...state.data, status: 'error', error: e.status === 404 ? 'We could not find that information.' : e.message };
  }
  paintMain();
}

async function loadStaff() {
  const st = state.staff;
  st.status = 'loading';
  paintMain();
  try {
    const r = await api.staffClients();
    st.clients = r.clients;
    st.providers = r.providers ?? [];
    st.status = 'ready';
    st.error = '';
  } catch (e) {
    st.status = 'error';
    st.error = e.status === 404 ? 'This area is for Taxcart staff.' : e.message;
  }
  paintMain();
}

async function submitStaffForm(form) {
  const st = state.staff;
  if (st.busy) return;
  const v = (id) => form.elements[id].value.trim();
  st.form = { name: v('name'), product: v('product'), provider: v('provider'), token: v('token'), providerCompanyId: v('providerCompanyId'), email: v('email') };
  if (!st.form.name || !st.form.token) { st.formError = 'Enter the client name and their provider token.'; return paintMain(); }
  Object.assign(st, { busy: true, formError: '', result: null, notice: null });
  paintMain();
  try {
    const f = st.form;
    const r = await api.staffCreateClient({ name: f.name, product: f.product, provider: f.provider, token: f.token, ...(f.providerCompanyId ? { providerCompanyId: f.providerCompanyId } : {}), ...(f.email ? { email: f.email } : {}) });
    st.result = { name: r.client.name, email: f.email, invite: r.invite, sync: r.sync };
    st.form = freshForm(); // clears the token from memory as soon as it has been used
    st.busy = false;
    await loadStaff();
  } catch (e) {
    st.busy = false;
    st.formError = e.message;
    paintMain();
  }
}

async function loadManage() {
  const m = state.staff.manage;
  if (!m) return;
  const id = m.tenantId;
  try {
    const r = await api.staffUsers(id);
    if (state.staff.manage?.tenantId !== id) return;
    Object.assign(m, { status: 'ready', users: r.users });
  } catch (e) {
    if (state.staff.manage?.tenantId !== id) return;
    Object.assign(m, { status: 'error', error: e.message });
  }
  paintMain();
}

async function manageAction(fn, okText) {
  const m = state.staff.manage;
  if (!m || m.busy) return;
  m.busy = true; m.notice = null; paintMain();
  try { await fn(m.tenantId); m.notice = { tone: 'info', text: okText }; }
  catch (e) { m.notice = { tone: 'error', text: e.message }; }
  m.busy = false;
  await Promise.all([loadManage(), loadStaff()]);
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('That file could not be read.'));
    r.readAsDataURL(file);
  });
}

async function staffSyncNow(connectionId) {
  const st = state.staff;
  if (st.syncing) return;
  st.syncing = connectionId;
  paintMain();
  try {
    const r = await api.staffSync(connectionId);
    st.result = null;
    st.notice = r.sync.status === 'succeeded'
      ? { tone: 'info', text: `Refreshed: ${r.sync.registrations} registration(s), ${r.sync.filings} filing(s).` }
      : { tone: 'error', text: `Refresh did not complete${r.sync.error ? `: ${r.sync.error}` : '.'}` };
  } catch (e) {
    st.notice = { tone: 'error', text: e.message };
  }
  st.syncing = null;
  await loadStaff();
}

function paintMain() {
  const main = document.getElementById('main');
  if (main && state.screen === 'app') { main.innerHTML = renderMain(); applyWidths(); }
}

/* ---------------------------------------------------------------- boot / render */
function chooseDefaults() {
  const s = state.session;
  const t = s.tenants.find((x) => x.id === state.tenantId) ?? s.tenants[0] ?? null;
  state.tenantId = t?.id ?? null;
  state.product = t?.products.find((p) => p.product === state.product)?.product ?? t?.products[0]?.product ?? null;
  if (state.view === 'nexus' && state.product !== 'us_sales_tax') state.view = 'overview';
}

async function boot() {
  try {
    state.session = await api.session();
    chooseDefaults();
    if (state.session.user.isStaff && !currentTenant()?.products.length) state.view = 'staff';
    resetData();
    setScreen('app');
    if (state.view === 'staff') loadStaff(); else load();
  } catch (e) {
    if (e.status === 401) { setScreen('login'); return; }
    root.innerHTML = `<div class="login-wrap"><main class="login-form-side"><div class="login-form"><h1>We are having trouble</h1><div class="sub">${esc(e.message)}</div><button class="btn btn-primary" data-action="reload">Try again</button></div></main></div>`;
  }
}

function render() {
  root.innerHTML = state.screen === 'login' ? renderLogin() : state.screen === 'app' ? renderShell() : '<div class="loading" role="status">Loading…</div>';
  applyWidths();
}

/* ---------------------------------------------------------------- events */
root.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (ev.target.id === 'staff-form') { submitStaffForm(ev.target); return; }
  if (ev.target.id === 'user-form') {
    const f = ev.target;
    const email = f.elements.email.value.trim();
    if (!email) { state.staff.manage.notice = { tone: 'error', text: 'Enter their email address.' }; return paintMain(); }
    manageAction((tenantId) => api.staffAddUser({ tenantId, email, role: f.elements.role.value }), `Access given to ${email}. They can sign in with an emailed code.`);
    return;
  }
  const l = state.login;
  if (l.busy) return;
  if (ev.target.id === 'email-form') {
    const email = ev.target.elements.email.value.trim();
    if (!email) { l.error = 'Enter your email address.'; return render(); }
    Object.assign(l, { email, busy: true, error: '', info: '' }); render();
    try { await api.requestCode(email); Object.assign(l, { step: 'code', busy: false, error: '' }); }
    catch (e) { Object.assign(l, { busy: false, error: e.status === 429 ? 'Too many requests. Please wait a few minutes and try again.' : e.message }); }
    render();
  } else if (ev.target.id === 'code-form') {
    const code = ev.target.elements.code.value.trim();
    if (!/^\d{6,10}$/.test(code)) { l.error = 'Enter the numeric code from your email.'; return render(); }
    Object.assign(l, { busy: true, error: '' }); render();
    try {
      await api.verifyCode(l.email, code);
      state.login = freshLogin();
      await boot();
    } catch (e) {
      Object.assign(l, { busy: false, error: e.status === 429 ? 'Too many attempts. Please wait a few minutes and try again.' : e.message });
      render();
    }
  }
});

root.addEventListener('change', async (ev) => {
  if (ev.target.id === 'logo-file') {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    if (file.size > 150_000) { state.staff.manage.notice = { tone: 'error', text: 'That image is too large. Please use one under 150 KB.' }; return paintMain(); }
    await manageAction(async (tenantId) => { await api.staffSetLogo({ tenantId, data: await readFileBase64(file) }); state.staff.logoVersion += 1; }, 'Logo saved. The client sees it next time they load the portal.');
    return;
  }
  if (ev.target.id === 'tenant') { state.tenantId = ev.target.value; state.product = null; state.offset = 0; chooseDefaults(); resetData(); render(); load(); }
});

root.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'login-back') { Object.assign(state.login, { step: 'email', error: '', info: '' }); render(); }
  else if (a === 'reload') location.reload();
  else if (a === 'retry') load();
  else if (a === 'nav') { state.view = el.dataset.view; state.offset = 0; resetData(); render(); if (state.view === 'staff') loadStaff(); else load(); }
  else if (a === 'staff-sync') staffSyncNow(el.dataset.conn);
  else if (a === 'staff-manage') { state.staff.manage = { tenantId: el.dataset.tenant, status: 'loading', users: [], error: '', notice: null, busy: false }; paintMain(); loadManage(); document.getElementById('manage-card')?.scrollIntoView?.({ block: 'start' }); }
  else if (a === 'staff-manage-close') { state.staff.manage = null; paintMain(); }
  else if (a === 'staff-remove-user') { if (confirm('Remove this person\'s access to the client?')) manageAction((tenantId) => api.staffRemoveUser({ tenantId, userId: el.dataset.user }), 'Access removed.'); }
  else if (a === 'staff-remove-logo') manageAction(async (tenantId) => { await api.staffSetLogo({ tenantId, remove: true }); state.staff.logoVersion += 1; }, 'Logo removed.');
  else if (a === 'staff-reload') loadStaff();
  else if (a === 'product') { state.product = el.dataset.product; state.offset = 0; if (state.view === 'nexus' && state.product !== 'us_sales_tax') state.view = 'overview'; resetData(); render(); load(); }
  else if (a === 'page-next') { state.offset += PAGE; load(); }
  else if (a === 'page-prev') { state.offset = Math.max(0, state.offset - PAGE); load(); }
  else if (a === 'logout') {
    try { await api.logout(); } catch { /* cookies are cleared server-side when reachable; either way show the login screen */ }
    state.session = null; token++; state.staff = freshStaff(); state.login = freshLogin(); setScreen('login');
  }
});

boot();
