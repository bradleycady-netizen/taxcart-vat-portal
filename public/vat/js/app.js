import { createApi } from '/js/api.js';
import { esc } from './format.js';
import { previewBanner, shell, navItem, whoBox, signOut, I, loginScreen, clientReturns, uploadPage, questionsPage, documentsPage, detailPage, staffQueue, staffClients, staffCountries } from './views.js';

const root = document.getElementById('app');

const freshLogin = (info = '') => ({ step: 'email', email: '', busy: false, error: '', info });
const freshUpload = () => ({ regId: null, period: null, file: null, status: 'idle', result: null, error: '', over: false, doneId: null, replaced: false });
const load0 = (extra = {}) => ({ status: 'loading', error: '', ...extra });

const state = {
  screen: 'boot', // boot | login | app
  login: freshLogin(),
  session: null,
  tenantId: null,
  view: 'returns',
  from: 'returns',
  country: '',
  client: load0({ registrations: [], returns: [] }),
  upload: freshUpload(),
  detail: load0({ id: null, ret: null, events: [], uploadSummary: null, notice: null, busy: false }),
  staff: load0({ returns: [], clients: [], countries: [], schemes: [] }),
  filter: { status: '', country: '', client: '' },
  clientsUi: { notice: null, busy: false },
  preview: null, // { tenantId, name } while a staff member is looking at the portal as a client
};
let stamp = 0;

const api = createApi({
  onUnauthorized: () => {
    if (state.screen === 'app') { state.session = null; state.login = freshLogin('Your session has ended. Please sign in again.'); setScreen('login'); }
  },
});

const isStaff = () => state.session?.user.isStaff === true;
/** Staff screens are shown to staff, except while they are previewing a client. */
const staffMode = () => isStaff() && !state.preview;
const tenant = () => (state.preview ? { id: state.preview.tenantId, name: state.preview.name } : state.session?.tenants.find((t) => t.id === state.tenantId) ?? null);

/* ---------------------------------------------------------------- rendering */
function setScreen(s) { state.screen = s; render(); }

function renderApp() {
  const s = state.session;
  const staff = staffMode();
  const now = new Date();
  let nav = '', who = '', body = '';
  if (staff) {
    who = whoBox('Taxcart staff', 'VAT operations');
    const v = state.view === 'detail' ? state.from : state.view;
    nav = navItem('queue', 'Submissions', I.queue, v === 'queue') + navItem('clients', 'Clients', I.people, v === 'clients') + navItem('countries', 'Countries & schemes', I.globe, v === 'countries');
    if (state.view === 'detail') body = detailPage(state.detail, true);
    else if (state.view === 'clients') body = staffClients(state.staff, state.clientsUi);
    else if (state.view === 'countries') body = staffCountries(state.staff, state.staff);
    else body = staffQueue(state.staff, state.filter, now);
  } else {
    const t = tenant();
    if (!t) {
      body = `<h1 class="title">Welcome</h1><div class="empty"><strong>No company is linked to this login yet</strong>Please contact your Taxcart representative.</div>`;
      return shell({ nav: '', who: whoBox('Taxcart', 'VAT portal'), body, footer: signOut(s.user.email) });
    }
    const picker = s.tenants.length > 1 ? `<label class="visually-hidden" for="tenant">Company</label><select class="sel" id="tenant">${s.tenants.map((x) => `<option value="${esc(x.id)}" ${x.id === state.tenantId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : '';
    who = whoBox(t.name, state.preview ? 'Staff preview' : s.user.email) + (state.preview ? '' : picker);
    const v = state.view === 'detail' ? state.from : state.view;
    const waiting = state.client.returns.filter((r) => r.awaitingClient).length;
    nav = navItem('returns', 'My returns', I.returns, v === 'returns') + navItem('upload', 'New submission', I.upload, v === 'upload') + navItem('questions', 'Questions', I.chat, v === 'questions', waiting) + navItem('documents', 'Documents', I.folder, v === 'documents');
    if (state.view === 'detail') body = detailPage(state.detail, false);
    else if (state.view === 'upload') body = uploadPage(state.client, state.upload);
    else if (state.view === 'questions') body = questionsPage(state.client);
    else if (state.view === 'documents') body = documentsPage(state.client);
    else body = clientReturns(state.client, state.country, now);
    if (state.preview) { body = previewBanner(state.preview.name) + body; nav += `<button class="nav" data-action="exit-preview">${I.back}<span class="grow">Exit preview</span></button>`; }
  }
  return shell({ nav, who, body, footer: staff ? signOut(s.user.email) : `Need a hand? Your Taxcart team is here.<br>${signOut(s.user.email)}` });
}

function render() {
  const active = document.activeElement?.id;
  root.innerHTML = state.screen === 'login' ? loginScreen(state.login) : state.screen === 'app' ? renderApp() : '<div class="loading" role="status">Loading…</div>';
  if (active && root.querySelector(`#${CSS.escape(active)}`) && !['file-input', 'return-file'].includes(active)) root.querySelector(`#${CSS.escape(active)}`)?.focus?.();
}
const note = (text, tone = 'info') => ({ text, tone });

/* ---------------------------------------------------------------- data */
async function loadClient() {
  const my = ++stamp;
  if (!tenant()) return;
  try {
    const r = await api.vatList(state.tenantId, !!state.preview);
    if (my !== stamp) return;
    state.client = { status: 'ready', error: '', registrations: r.registrations, returns: r.returns };
  } catch (e) {
    if (my !== stamp || state.screen !== 'app') return;
    state.client = { ...state.client, status: 'error', error: e.message };
  }
  render();
}

async function loadStaff() {
  const my = ++stamp;
  try {
    const [q, c] = await Promise.all([api.vatQueue(), api.vatClients()]);
    if (my !== stamp) return;
    state.staff = { status: 'ready', error: '', returns: q.returns, clients: c.clients, countries: c.countries, schemes: c.schemes };
  } catch (e) {
    if (my !== stamp || state.screen !== 'app') return;
    state.staff = { ...state.staff, status: 'error', error: e.status === 404 ? 'This area is for Taxcart staff.' : e.message };
  }
  render();
}
const reloadData = () => (staffMode() ? loadStaff() : loadClient());

async function loadDetail(id, keepNotice = false) {
  try {
    const r = await api.vatDetail(id, !!state.preview);
    if (state.detail.id !== id) return;
    state.detail = { ...state.detail, status: 'ready', error: '', ret: r.return, events: r.events, uploadSummary: r.uploadSummary ?? null, busy: false, notice: keepNotice ? state.detail.notice : null };
  } catch (e) {
    if (state.detail.id !== id) return;
    state.detail = { ...state.detail, status: 'error', error: e.status === 404 ? 'We could not find that return.' : e.message, busy: false };
  }
  render();
}

function openReturn(id) {
  state.from = state.view === 'detail' ? state.from : state.view === 'upload' ? 'returns' : state.view;
  state.view = 'detail';
  state.detail = load0({ id, ret: null, events: [], uploadSummary: null, notice: null, busy: false });
  render();
  window.scrollTo?.(0, 0);
  loadDetail(id);
}

function go(view) {
  state.view = view;
  state.country = view === 'returns' ? state.country : '';
  if (view === 'upload') { state.upload = freshUpload(); }
  render();
  window.scrollTo?.(0, 0);
  if (staffMode() ? (view === 'queue' || view === 'clients' || view === 'countries') : true) reloadData();
}

async function chooseTenant(id) {
  state.tenantId = id;
  state.client = load0({ registrations: [], returns: [] });
  state.upload = freshUpload();
  state.view = 'returns';
  state.country = '';
  render();
  loadClient();
}

async function boot() {
  try {
    state.session = await api.session();
    state.tenantId = state.session.tenants.find((t) => t.id === state.tenantId)?.id ?? state.session.tenants[0]?.id ?? null;
    state.view = isStaff() ? 'queue' : 'returns';
    setScreen('app');
    reloadData();
  } catch (e) {
    if (e.status === 401) { setScreen('login'); return; }
    root.innerHTML = `<div class="login"><section class="login-form-side"><div class="login-form"><h2>We are having trouble</h2><p class="sub">${esc(e.message)}</p><button class="btn" data-action="reload">Try again</button></div></section></div>`;
  }
}

/* ---------------------------------------------------------------- uploads */
function currentPeriod() {
  const reg = state.client.registrations.find((r) => r.id === state.upload.regId) ?? state.client.registrations[0];
  if (!reg) return null;
  const p = reg.periods.find((x) => x.code === state.upload.period) ?? reg.periods.find((x) => !x.returnId) ?? reg.periods[0];
  return { reg, p };
}
const uploadParams = () => { const c = currentPeriod(); return { tenant: state.tenantId, scheme: c.reg.scheme, country: c.reg.country, period: c.p.code, behalf: state.preview ? 1 : undefined }; };

async function checkFile(file) {
  const u = state.upload;
  const c = currentPeriod();
  if (!file || !c) return;
  Object.assign(u, { regId: c.reg.id, period: c.p.code, file, status: 'checking', result: null, error: '' });
  render();
  const mine = file;
  try {
    const r = await api.vatCheck(uploadParams(), file);
    if (u.file !== mine) return;
    u.result = r.result;
    u.status = 'checked';
  } catch (e) {
    if (u.file !== mine) return;
    u.status = 'idle';
    u.result = null;
    u.error = e.message;
  }
  render();
}

async function submitFile() {
  const u = state.upload;
  if (u.status !== 'checked' || !u.result?.ok || !u.file) return;
  u.status = 'submitting';
  u.error = '';
  render();
  try {
    const r = await api.vatSubmit(uploadParams(), u.file);
    Object.assign(u, { status: 'done', doneId: r.id, replaced: r.replaced, result: r.result });
    loadClient();
  } catch (e) {
    u.status = 'checked';
    if (e.data?.result) { u.result = e.data.result; u.error = ''; } else u.error = e.message;
  }
  render();
}

async function submitNil() {
  const u = state.upload;
  if (u.status === 'submitting') return;
  u.status = 'submitting';
  u.error = '';
  render();
  try {
    const r = await api.vatSubmitNil(uploadParams());
    Object.assign(u, { status: 'done', doneId: r.id, replaced: false, nil: true, nilAsk: false, result: null });
    loadClient();
  } catch (e) {
    u.status = 'idle';
    u.error = e.message;
  }
  render();
}

async function downloadFile(id, kind) {
  try {
    const r = await api.vatDownload(id, kind);
    window.location.assign(r.url);
  } catch (e) {
    const target = state.view === 'detail' ? state.detail : null;
    if (target) { target.notice = note(e.message, 'error'); render(); } else alert(e.message);
  }
}

/* ---------------------------------------------------------------- events */
const val = (form, name) => (form.elements[name]?.value ?? '').trim();

root.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const l = state.login;
  if (f.id === 'email-form') {
    if (l.busy) return;
    const email = val(f, 'email');
    if (!email) { l.error = 'Enter your email address.'; return render(); }
    Object.assign(l, { email, busy: true, error: '', info: '' }); render();
    try { await api.requestCode(email); Object.assign(l, { step: 'code', busy: false, error: '' }); }
    catch (e) { Object.assign(l, { busy: false, error: e.status === 429 ? 'Too many requests. Please wait a few minutes and try again.' : e.message }); }
    render();
  } else if (f.id === 'code-form') {
    if (l.busy) return;
    const code = val(f, 'code');
    if (!/^\d{6,10}$/.test(code)) { l.error = 'Enter the numeric code from your email.'; return render(); }
    Object.assign(l, { busy: true, error: '' }); render();
    try { await api.verifyCode(l.email, code); state.login = freshLogin(); await boot(); }
    catch (e) { Object.assign(l, { busy: false, error: e.status === 429 ? 'Too many attempts. Please wait a few minutes and try again.' : e.message }); render(); }
  } else if (f.id === 'reply-form') {
    const d = state.detail;
    const body = val(f, 'body');
    if (!body) { d.notice = note('Write a message first.', 'error'); return render(); }
    d.busy = true; d.notice = null; render();
    try {
      if (staffMode()) await api.vatAsk(d.id, body); else await api.vatReply(d.id, body, !!state.preview);
      d.notice = note(staffMode() ? 'Question sent. The return now shows as waiting on the client.' : 'Reply sent to Taxcart.');
    } catch (e) { d.notice = note(e.message, 'error'); }
    await loadDetail(d.id, true);
    loadStaffOrClientQuiet();
  } else if (f.id === 'status-form') {
    const d = state.detail;
    d.busy = true; d.notice = null; render();
    try {
      await api.vatSetStatus({ id: d.id, status: val(f, 'status'), dueOn: val(f, 'dueOn') || undefined, note: val(f, 'note') || undefined });
      d.notice = note('Updated.');
    } catch (e) { d.notice = note(e.message, 'error'); }
    await loadDetail(d.id, true);
    loadStaffOrClientQuiet();
  } else if (f.id === 'client-form') {
    const ui = state.clientsUi;
    if (ui.busy) return;
    ui.busy = true; ui.notice = null; render();
    try {
      const r = await api.vatCreateClient({ name: val(f, 'name'), ...(val(f, 'email') ? { email: val(f, 'email') } : {}) });
      ui.notice = note(`${r.client.name} added.${r.invite === 'created' || r.invite === 'existing' ? emailNote(r.emailed) : r.invite === 'failed' ? ' The invitation could not be set up; add them below.' : ''}`);
    } catch (e) { ui.notice = note(e.message, 'error'); }
    ui.busy = false;
    await loadStaff();
  } else if (f.dataset.form === 'register') {
    const ui = state.clientsUi;
    ui.notice = null;
    try {
      await api.vatRegister({ tenantId: f.dataset.tenant, scheme: val(f, 'scheme'), country: val(f, 'country'), frequency: val(f, 'frequency'), vatNumber: val(f, 'vatNumber') });
      ui.notice = note('Filing added.');
    } catch (e) { ui.notice = note(e.message, 'error'); }
    await loadStaff();
  } else if (f.dataset.form === 'invite') {
    const ui = state.clientsUi;
    ui.notice = null;
    const email = val(f, 'email');
    try {
      await api.vatInvite({ tenantId: f.dataset.tenant, email });
      ui.notice = note(`Welcome email sent to ${email}.`);
    } catch (e) { ui.notice = note(e.message, 'error'); }
    await loadStaff();
  } else if (f.dataset.form === 'access') {
    const ui = state.clientsUi;
    ui.notice = null;
    const email = val(f, 'email');
    try {
      const r = await api.staffAddUser({ tenantId: f.dataset.tenant, email, role: val(f, 'role'), welcome: true });
      ui.notice = note(`Access given to ${email}.${emailNote(r.emailed)}`);
    } catch (e) { ui.notice = note(e.message, 'error'); }
    await loadStaff();
  }
});

function emailNote(emailed) {
  if (emailed === 'sent') return ' We emailed them the portal link and instructions.';
  if (emailed === 'failed') return ' The welcome email could not be sent; use "Resend welcome email" below, or send them the link yourself.';
  return ' Welcome emails are not switched on yet, so send them the portal link yourself. They sign in with an emailed code.';
}

/** Refresh the lists behind the detail page without disturbing it. */
function loadStaffOrClientQuiet() { reloadData(); }

root.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.id === 'tenant') return chooseTenant(t.value);
  if (t.id === 'reg') { Object.assign(state.upload, { nilAsk: false, regId: t.value, period: null, file: null, result: null, status: 'idle', error: '' }); return render(); }
  if (t.id === 'period') { Object.assign(state.upload, { nilAsk: false, period: t.value, file: null, result: null, status: 'idle', error: '' }); return render(); }
  if (t.id === 'file-input') { const file = t.files?.[0]; if (file) checkFile(file); return; }
  if (t.dataset.filter) { state.filter[t.dataset.filter] = t.value; return render(); }
  if (t.id === 'return-file') {
    const file = t.files?.[0];
    t.value = '';
    if (!file) return;
    const d = state.detail;
    d.busy = true; d.notice = null; render();
    try { await api.vatAttachReturn(d.id, file); d.notice = note('Return PDF attached.'); } catch (e) { d.notice = note(e.message, 'error'); }
    await loadDetail(d.id, true);
    loadStaffOrClientQuiet();
  }
});

root.addEventListener('dragover', (ev) => { if (ev.target.closest?.('[data-drop]')) { ev.preventDefault(); if (!state.upload.over) { state.upload.over = true; ev.target.closest('[data-drop]').classList.add('over'); } } });
root.addEventListener('dragleave', (ev) => { const z = ev.target.closest?.('[data-drop]'); if (z) { state.upload.over = false; z.classList.remove('over'); } });
root.addEventListener('drop', (ev) => {
  if (!ev.target.closest?.('[data-drop]')) return;
  ev.preventDefault();
  state.upload.over = false;
  const file = ev.dataTransfer?.files?.[0];
  if (file) checkFile(file); else render();
});

root.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'login-back') { Object.assign(state.login, { step: 'email', error: '', info: '' }); render(); }
  else if (a === 'reload') location.reload();
  else if (a === 'reload-data') { if (state.view === 'detail') loadDetail(state.detail.id); else reloadData(); }
  else if (a === 'nav') go(el.dataset.view);
  else if (a === 'back') go(state.from);
  else if (a === 'open-return') openReturn(el.dataset.id);
  else if (a === 'download') downloadFile(el.dataset.id, el.dataset.kind);
  else if (a === 'filter-country') { state.country = el.dataset.code; render(); }
  else if (a === 'start-upload') { state.view = 'upload'; state.upload = { ...freshUpload(), regId: el.dataset.reg, period: el.dataset.period }; render(); window.scrollTo?.(0, 0); }
  else if (a === 'submit-file') submitFile();
  else if (a === 'ask-nil') { state.upload.nilAsk = true; state.upload.error = ''; render(); }
  else if (a === 'cancel-nil') { state.upload.nilAsk = false; render(); }
  else if (a === 'confirm-nil') submitNil();
  else if (a === 'upload-another') { state.upload = freshUpload(); render(); }
  else if (a === 'preview') {
    state.preview = { tenantId: el.dataset.tenant, name: el.dataset.name };
    state.tenantId = el.dataset.tenant;
    state.client = load0({ registrations: [], returns: [] });
    state.upload = freshUpload();
    state.country = '';
    state.view = 'returns';
    render(); window.scrollTo?.(0, 0); loadClient();
  } else if (a === 'exit-preview') {
    state.preview = null;
    state.tenantId = state.session.tenants[0]?.id ?? null;
    state.upload = freshUpload();
    state.view = 'clients';
    render(); window.scrollTo?.(0, 0); loadStaff();
  } else if (a === 'unregister') {
    if (!confirm('Remove this filing? Returns already submitted are kept.')) return;
    state.clientsUi.notice = null;
    try { await api.vatUnregister(el.dataset.id); state.clientsUi.notice = note('Filing removed.'); } catch (e) { state.clientsUi.notice = note(e.message, 'error'); }
    await loadStaff();
  } else if (a === 'logout') {
    try { await api.logout(); } catch { /* cookies are cleared server-side when reachable; show the sign-in screen either way */ }
    stamp++;
    Object.assign(state, { preview: null, session: null, tenantId: null, view: 'returns', client: load0({ registrations: [], returns: [] }), staff: load0({ returns: [], clients: [], countries: [], schemes: [] }), upload: freshUpload(), login: freshLogin() });
    setScreen('login');
  }
});

boot();
