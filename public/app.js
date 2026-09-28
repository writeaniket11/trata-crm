(function () {
'use strict';
const TZ = 'Asia/Kolkata';
const BUSINESS = ['Shop / Retail', 'Doctor / Clinic / Hospital', 'Restaurant / Cafe / Cloud kitchen', 'Real Estate / Builder',
  'Coaching / School / Education', 'Salon / Spa / Gym / Fitness', 'Manufacturer / Wholesaler / Trader',
  'Hotel / Travel / Tour agency', 'CA / Lawyer / Consultant', 'Other business'];
const NEEDS = ['New website', 'Website redesign', 'Mobile app', 'WhatsApp automation / Bulk SMS', 'Branding / Logo', 'SEO / Digital marketing'];

let ME = null, STATUSES = [], TYPES = [], USERS = [], LEADS = [];
let view = 'dash', openId = null, resetFor = null, lastVersion = null, lastMax = 0;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TRATA-CRM' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (res.status === 401 && url !== '/api/auth/login' && url !== '/api/setup') { showLogin(data.error); throw new Error(data.error || 'Please log in.'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2200); }
function today() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function fmt(iso) { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
function fmtDay(s) { if (!s) return ''; return new Date(s + 'T12:00:00+05:30').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: TZ }); }
function ago(iso) { const m = (Date.now() - new Date(iso)) / 60000; if (m < 60) return Math.max(1, Math.round(m)) + ' min ago'; const h = m / 60; if (h < 24) return Math.round(h) + ' h ago'; return Math.round(h / 24) + ' d ago'; }
function wa(p) { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d; }
function isOpen(l) { return l.status !== 'Won' && l.status !== 'Lost'; }
function isDue(l) { return !!l.follow_up && l.follow_up <= today() && isOpen(l); }
function sCls(s) { return 's-' + String(s).replace(/\s+/g, '.'); }
function userOptions(sel, withNone) {
  return (withNone ? '<option value="">Unassigned</option>' : '') +
    USERS.map((u) => `<option value="${u.id}" ${String(u.id) === String(sel) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
}

// ---------- login ----------
function showLogin(msg) {
  $('#booting').hidden = true; $('#app').hidden = true; $('#setup').hidden = true; $('#gate').hidden = false;
  closeAll(); $('#loginErr').textContent = msg && msg !== 'Please log in.' ? msg : '';
  $('#g-id').focus();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#loginErr').textContent = ''; $('#loginBtn').disabled = true;
  try {
    await api('POST', '/api/auth/login', { username: $('#g-id').value.trim(), password: $('#g-pw').value, remember: $('#remember').checked });
    $('#g-pw').value = '';
    await start();
  } catch (err) { $('#loginErr').textContent = err.message; } finally { $('#loginBtn').disabled = false; }
});

// ---------- first-run setup ----------
$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#setupErr').textContent = '';
  if ($('#s-pw').value !== $('#s-pw2').value) { $('#setupErr').textContent = 'The two passwords are not the same.'; return; }
  $('#setupBtn').disabled = true;
  try {
    await api('POST', '/api/setup', { code: $('#s-code').value.trim(), name: $('#s-name').value.trim(),
      username: $('#s-id').value.trim(), password: $('#s-pw').value });
    $('#s-pw').value = ''; $('#s-pw2').value = '';
    $('#setup').hidden = true; toast('Admin created. Welcome!');
    await start();
  } catch (err) { $('#setupErr').textContent = err.message; } finally { $('#setupBtn').disabled = false; }
});

async function start() {
  const meta = await api('GET', '/api/meta');
  ME = meta.me; STATUSES = meta.statuses; TYPES = meta.activityTypes; USERS = meta.users;
  $('#gate').hidden = true; $('#setup').hidden = true; $('#booting').hidden = true; $('#app').hidden = false;
  $('#userBtn').textContent = ME.name + ' ▾';
  $('#teamTab').hidden = ME.role !== 'admin'; $('#exportBtn').hidden = ME.role !== 'admin';
  $('#fStatus').innerHTML = '<option value="">All statuses</option><option value="__open">All open (not Won/Lost)</option><option value="__warm">Interested + Quote sent</option>' + STATUSES.map((s) => `<option>${esc(s)}</option>`).join('');
  $('#a-business').innerHTML = BUSINESS.map((b) => `<option>${esc(b)}</option>`).join('');
  $('#a-need').innerHTML = NEEDS.map((b) => `<option>${esc(b)}</option>`).join('');
  ['q', 'fStatus', 'fPrio', 'fAssigned', 'fDue'].forEach((id) => ($('#' + id).value = ''));
  setView('dash');
  await loadLeads();
}

async function loadLeads() {
  $('#refresh').disabled = true;
  try {
    const d = await api('GET', '/api/leads');
    LEADS = d.leads;
    const v = await api('GET', '/api/leads/version'); lastVersion = v.version; lastMax = v.max_id;
    $('#sync').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    render();
  } finally { $('#refresh').disabled = false; }
}

// ---------- render ----------
function render() {
  const cur = $('#fAssigned').value;
  $('#fAssigned').innerHTML = '<option value="">Anyone</option><option value="none">Unassigned</option>' +
    USERS.map((u) => `<option value="${u.id}" ${String(u.id) === cur ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  renderDash(); renderList(); renderBoard();
}

function renderDash() {
  const L = LEADS, t = today();
  const newC = L.filter((l) => l.status === 'New').length;
  const hotNew = L.filter((l) => l.status === 'New' && l.priority === 'Hot').length;
  const due = L.filter(isDue).length;
  const warm = L.filter((l) => l.status === 'Interested' || l.status === 'Quote sent').length;
  const won = L.filter((l) => l.status === 'Won').length;
  const todayC = L.filter((l) => new Date(l.received_at).toLocaleDateString('en-CA', { timeZone: TZ }) === t).length;
  const closed = L.filter((l) => !isOpen(l)).length;
  const conv = closed ? Math.round((won / closed) * 100) : 0;
  const tiles = [['New today', todayC, '', ''], ['Not contacted', newC, newC ? 'alert' : '', 'New'], ['Hot & waiting', hotNew, hotNew ? 'hot' : '', 'hot'],
    ['Follow-ups due', due, due ? 'alert' : '', 'due'], ['Interested / Quoted', warm, '', 'warm'], ['Won', won, 'good', 'Won'], ['Win rate (closed)', conv + '%', '', '']];
  $('#kpis').innerHTML = tiles.map(([l, v, c, go]) => go
    ? `<button class="kpi ${c}" type="button" data-go="${go}"><b>${v}</b><span>${l}</span></button>`
    : `<div class="kpi ${c}"><b>${v}</b><span>${l}</span></div>`).join('');

  const todo = [
    ...L.filter(isDue).sort((a, b) => a.follow_up.localeCompare(b.follow_up)).map((l) => [l, l.follow_up < t ? 'Overdue follow-up · ' + fmtDay(l.follow_up) : 'Follow-up today']),
    ...L.filter((l) => l.status === 'New' && l.priority === 'Hot').map((l) => [l, 'Hot lead · not contacted · ' + ago(l.received_at)]),
    ...L.filter((l) => l.status === 'New' && l.priority !== 'Hot').map((l) => [l, 'New lead · ' + ago(l.received_at)]),
  ];
  const seen = new Set();
  const list = todo.filter(([l]) => !seen.has(l.id) && seen.add(l.id)).slice(0, 12);
  $('#todo').innerHTML = list.length ? list.map(([l, why]) => `<button class="todo-row" type="button" data-id="${l.id}">
      <span class="pill p-${esc(l.priority)}">${esc(l.priority)}</span>
      <span class="todo-main"><strong>${esc(l.name || 'Unnamed')}</strong><small>${esc(why)}${l.assigned_name ? ' · ' + esc(l.assigned_name) : ''}</small></span>
      <span class="pill ${sCls(l.status)}">${esc(l.status)}</span></button>`).join('')
    : '<div class="empty">All caught up. No follow-ups due and no new leads waiting.</div>';

  const max = Math.max(1, ...STATUSES.map((s) => L.filter((l) => l.status === s).length));
  $('#bars').innerHTML = STATUSES.map((s) => { const n = L.filter((l) => l.status === s).length;
    return `<div class="bar"><span>${esc(s)}</span><div class="bar-track"><div class="bar-fill" style="width:${(n / max) * 100}%"></div></div><b>${n}</b></div>`; }).join('');
  const needs = {}; L.forEach((l) => { const k = l.need || 'Not given'; needs[k] = (needs[k] || 0) + 1; });
  const nk = Object.entries(needs).sort((a, b) => b[1] - a[1]); const nm = Math.max(1, ...nk.map((x) => x[1]));
  $('#needs').innerHTML = nk.length ? nk.map(([k, n]) => `<div class="bar"><span>${esc(k)}</span><div class="bar-track"><div class="bar-fill" style="width:${(n / nm) * 100}%;opacity:.7"></div></div><b>${n}</b></div>`).join('')
    : '<div class="empty">No leads yet.</div>';
}

function filtered() {
  const q = $('#q').value.toLowerCase(), fs = $('#fStatus').value, fp = $('#fPrio').value, fa = $('#fAssigned').value, fd = $('#fDue').value;
  const stOk = (l) => !fs || (fs === '__open' ? isOpen(l) : fs === '__warm' ? (l.status === 'Interested' || l.status === 'Quote sent') : l.status === fs);
  return LEADS.filter((l) => stOk(l) && (!fp || l.priority === fp) &&
    (!fa || (fa === 'none' ? !l.assigned_to : String(l.assigned_to) === fa)) && (!fd || isDue(l)) &&
    (!q || [l.name, l.phone, l.need, l.business, l.notes, l.assigned_name].join(' ').toLowerCase().includes(q)));
}
function renderList() {
  const L = filtered();
  $('#count').textContent = L.length + ' of ' + LEADS.length + ' leads';
  $('#rows').innerHTML = L.length ? L.map((l) => `<tr data-id="${l.id}" tabindex="0">
    <td><strong>${esc(l.name || 'Unnamed')}</strong><span class="sub num">${esc(l.phone)}</span></td>
    <td><span class="pill p-${esc(l.priority)}">${esc(l.priority)}</span></td>
    <td><span class="pill ${sCls(l.status)}">${esc(l.status)}</span></td>
    <td class="hide-sm">${esc(l.need || '—')}<span class="sub">${esc(l.business)}</span></td>
    <td>${l.follow_up ? `<span class="${isDue(l) ? 'due' : ''}">${esc(fmtDay(l.follow_up))}</span>` : '—'}</td>
    <td class="hide-sm">${esc(l.assigned_name || '—')}</td>
    <td class="hide-sm">${esc(fmt(l.received_at))}</td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">No leads match these filters.</td></tr>';
}
function renderBoard() {
  $('#board').innerHTML = STATUSES.map((s) => {
    const L = LEADS.filter((l) => l.status === s);
    return `<div class="col"><div class="col-h">${esc(s)} <span>${L.length}</span></div>${L.map((l) => `<button class="lead-card" type="button" data-id="${l.id}">
      <strong>${esc(l.name || 'Unnamed')}</strong><small>${esc(l.need || l.business || '')}</small>
      <div class="row"><span class="pill p-${esc(l.priority)}">${esc(l.priority)}</span>${l.follow_up ? `<small class="${isDue(l) ? 'due' : ''}">↻ ${esc(fmtDay(l.follow_up))}</small>` : ''}${l.assigned_name ? `<small>· ${esc(l.assigned_name)}</small>` : ''}</div></button>`).join('')}</div>`;
  }).join('');
}

// ---------- lead drawer ----------
async function openLead(id) {
  openId = id;
  const dr = $('#drawer');
  dr.innerHTML = '<div class="loading">Loading…</div>'; dr.hidden = false; $('#scrim').hidden = false;
  let d; try { d = await api('GET', '/api/leads/' + id); } catch (e) { dr.innerHTML = `<div class="loading">${esc(e.message)}</div>`; return; }
  if (openId !== id) return;
  const l = d.lead, w = wa(l.phone);
  dr.innerHTML = `<div class="d-head"><div><h3>${esc(l.name || 'Unnamed')}</h3>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap"><span class="pill p-${esc(l.priority)}">${esc(l.priority)}</span><span class="pill ${sCls(l.status)}">${esc(l.status)}</span></div></div>
      <button class="x" type="button" id="dClose" aria-label="Close">&times;</button></div>
    <div class="d-body">
      <div class="contact"><span class="num" style="font-size:15px">${esc(l.phone || 'No phone')}</span>
        ${w ? `<a class="btn primary" href="https://wa.me/${w}" target="_blank" rel="noopener">WhatsApp</a><a class="btn" href="tel:+${w}">Call</a>` : ''}</div>
      <dl class="facts">
        <dt>Needs</dt><dd>${esc(l.need || '—')}</dd>
        <dt>Business</dt><dd>${esc(l.business || '—')}</dd>
        <dt>Wants to start</dt><dd>${esc(l.start || '—')}</dd>
        <dt>Came in</dt><dd>${esc(fmt(l.received_at))} (${esc(ago(l.received_at))})</dd>
        <dt>Source</dt><dd>${esc(l.campaign || l.source || '—')}</dd>
      </dl>
      <form class="form" id="dForm">
        <label>Status<select id="d-status">${STATUSES.map((s) => `<option ${s === l.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        <label>Follow-up date<input id="d-follow" type="date" value="${esc(l.follow_up || '')}"></label>
        <label class="full">Assigned to<select id="d-assigned">${userOptions(l.assigned_to, true)}</select></label>
        <label class="full">Notes<textarea id="d-notes" maxlength="5000" placeholder="Budget, requirement, next step…">${esc(l.notes)}</textarea></label>
        <div class="full d-actions"><button class="btn primary" type="submit" id="dSave">Save changes</button><span class="err" id="dErr" role="alert"></span></div>
      </form>
      <div><h2>Activity</h2>
        <form class="addnote" id="dLogForm">
          <select id="d-type" aria-label="Type">${TYPES.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
          <input id="d-log" placeholder="e.g. Called, asked for a quote" maxlength="2000" aria-label="Activity details">
          <button class="btn" type="submit" id="dLog">Add</button></form>
        <div class="timeline" style="margin-top:12px">${d.activities.length ? d.activities.map((a) => `<div class="t-item"><strong>${esc(a.type)}</strong>${a.details ? ' · ' + esc(a.details) : ''}<small>${esc(a.user_name || 'System')} · ${esc(fmt(a.created_at))}</small></div>`).join('') : '<div class="empty" style="text-align:left;padding:4px 0">No activity yet.</div>'}</div></div>
      ${ME.role === 'admin' ? '<div><button class="linkbtn danger" type="button" id="dDelete">Delete this lead</button></div>' : ''}
    </div>`;
  $('#dClose').onclick = closeAll;
  $('#dForm').onsubmit = async (e) => {
    e.preventDefault(); const b = $('#dSave'); b.disabled = true; $('#dErr').textContent = '';
    try {
      await api('PATCH', '/api/leads/' + id, { status: $('#d-status').value, follow_up: $('#d-follow').value || null,
        assigned_to: $('#d-assigned').value || null, notes: $('#d-notes').value });
      toast('Saved'); await loadLeads(); openLead(id);
    } catch (err) { $('#dErr').textContent = err.message; b.disabled = false; }
  };
  $('#dLogForm').onsubmit = async (e) => {
    e.preventDefault(); const t = $('#d-log').value.trim(); if (!t) return; $('#dLog').disabled = true;
    try { await api('POST', `/api/leads/${id}/activities`, { type: $('#d-type').value, details: t }); toast('Logged'); openLead(id); }
    catch (err) { toast(err.message); $('#dLog').disabled = false; }
  };
  const del = $('#dDelete');
  if (del) del.onclick = async () => {
    if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Tap again to delete permanently'; return; }
    try { await api('DELETE', '/api/leads/' + id); toast('Lead deleted'); closeAll(); await loadLeads(); } catch (err) { toast(err.message); }
  };
}
function closeAll() { openId = null; $('#drawer').hidden = true; $('#scrim').hidden = true; $('#addModal').hidden = true; $('#pwModal').hidden = true; $('#userMenu').hidden = true; }
$('#scrim').addEventListener('click', closeAll);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });

// ---------- add lead ----------
$('#addBtn').addEventListener('click', () => {
  $('#addModal').reset(); $('#a-assigned').innerHTML = userOptions(ME.id, true); $('#addErr').textContent = '';
  $('#addModal').hidden = false; $('#scrim').hidden = false; $('#a-name').focus();
});
$('#addModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeAll(); });
$('#addModal').addEventListener('submit', async (e) => {
  e.preventDefault(); const b = $('#addSave'); b.disabled = true; $('#addErr').textContent = '';
  try {
    await api('POST', '/api/leads', { name: $('#a-name').value, phone: $('#a-phone').value, source: $('#a-source').value,
      business: $('#a-business').value, need: $('#a-need').value, start: $('#a-start').value,
      assigned_to: $('#a-assigned').value || null, notes: $('#a-notes').value });
    closeAll(); toast('Lead added'); await loadLeads();
  } catch (err) { $('#addErr').textContent = err.message; } finally { b.disabled = false; }
});

// ---------- navigation ----------
function setView(v) {
  view = v;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === v)));
  ['dash', 'list', 'board', 'team'].forEach((x) => ($('#v-' + x).hidden = x !== v));
  if (v === 'team') { loadUsers(); loadMeta(); }
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) {
    const g = go.dataset.go; $('#fStatus').value = ''; $('#fPrio').value = ''; $('#fDue').value = ''; $('#q').value = ''; $('#fAssigned').value = '';
    if (g === 'hot') { $('#fStatus').value = 'New'; $('#fPrio').value = 'Hot'; } else if (g === 'due') $('#fDue').value = 'due';
    else if (g === 'warm') $('#fStatus').value = '__warm'; else $('#fStatus').value = g;
    renderList(); setView('list'); return;
  }
  const item = e.target.closest('[data-id]');
  if (item && !e.target.closest('#drawer')) openLead(Number(item.dataset.id));
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-id]')) openLead(Number(e.target.dataset.id)); });
['q', 'fStatus', 'fPrio', 'fAssigned', 'fDue'].forEach((id) => $('#' + id).addEventListener('input', renderList));
$('#refresh').addEventListener('click', () => loadLeads().catch((e) => toast(e.message)));
// Live updates: check every 5 s whether anything changed (new lead or a teammate's edit).
async function checkLive() {
  if (!ME || document.hidden) return;
  const v = await api('GET', '/api/leads/version');
  if (v.version === lastVersion) return;
  const prevMax = lastMax;
  await loadLeads();
  const fresh = LEADS.filter((l) => l.id > prevMax);
  if (prevMax && fresh.length) {
    toast(fresh.length === 1 ? `New lead: ${fresh[0].name || 'Unnamed'}` : `${fresh.length} new leads`);
    fresh.forEach((l) => document.querySelectorAll(`[data-id="${l.id}"]`).forEach((el) => el.classList.add('new-flash')));
    if (document.title.indexOf('(') !== 0) document.title = `(${fresh.length}) TRATA CRM`;
  }
}
setInterval(() => checkLive().catch(() => {}), 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { document.title = 'TRATA CRM'; checkLive().catch(() => {}); } });
window.addEventListener('focus', () => { document.title = 'TRATA CRM'; });

// ---------- user menu ----------
$('#userBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#userMenu').hidden = !$('#userMenu').hidden; });
document.addEventListener('click', (e) => { if (!e.target.closest('.usermenu')) $('#userMenu').hidden = true; });
$('#logoutBtn').addEventListener('click', async () => { try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ } ME = null; showLogin(); });
$('#exportBtn').addEventListener('click', () => { window.location.href = '/api/export.csv'; });

function openPw(forUser) {
  resetFor = forUser || null; $('#pwModal').reset(); $('#pwErr').textContent = '';
  $('#pwTitle').textContent = forUser ? 'Reset password for ' + forUser.name : 'Change password';
  $('#pwOldWrap').hidden = !!forUser; $('#pw-old').required = !forUser; $('#pw-new').type = forUser ? 'text' : 'password';
  $('#userMenu').hidden = true; $('#pwModal').hidden = false; $('#scrim').hidden = false;
}
$('#pwBtn').addEventListener('click', () => openPw());
$('#pwModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeAll(); });
$('#pwModal').addEventListener('submit', async (e) => {
  e.preventDefault(); const b = $('#pwSave'); b.disabled = true; $('#pwErr').textContent = '';
  try {
    if (resetFor) await api('PATCH', '/api/users/' + resetFor.id, { password: $('#pw-new').value });
    else await api('POST', '/api/auth/password', { current: $('#pw-old').value, password: $('#pw-new').value });
    closeAll(); toast('Password saved');
  } catch (err) { $('#pwErr').textContent = err.message; } finally { b.disabled = false; }
});

// ---------- team ----------
let TEAM = [];
async function loadUsers() {
  try { TEAM = (await api('GET', '/api/users')).users; renderUsers(); }
  catch (e) { $('#userList').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function renderUsers() {
  $('#userList').innerHTML = TEAM.map((u) => `<div class="urow"><div class="grow"><strong>${esc(u.name)}</strong> ${u.active ? '' : '<span class="badge-off">Deactivated</span>'}
      <small>${esc(u.username)} · ${u.role === 'admin' ? 'Admin' : 'Member'}</small></div>
    <button class="linkbtn" type="button" data-reset="${u.id}">Reset password</button>
    ${u.id === ME.id ? '' : `<button class="linkbtn ${u.active ? 'danger' : ''}" type="button" data-toggle="${u.id}">${u.active ? 'Deactivate' : 'Activate'}</button>`}</div>`).join('');
}
$('#userList').addEventListener('click', async (e) => {
  const r = e.target.closest('[data-reset]');
  if (r) { openPw(TEAM.find((u) => String(u.id) === r.dataset.reset)); return; }
  const t = e.target.closest('[data-toggle]');
  if (t) {
    const u = TEAM.find((x) => String(x.id) === t.dataset.toggle);
    try { await api('PATCH', '/api/users/' + u.id, { active: !u.active }); toast(u.active ? u.name + ' deactivated' : u.name + ' activated');
      USERS = (await api('GET', '/api/meta')).users; render(); await loadUsers(); } catch (err) { toast(err.message); }
  }
});
$('#userForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const b = $('#userSave'); b.disabled = true; $('#userErr').textContent = '';
  try {
    await api('POST', '/api/users', { name: $('#u-name').value, username: $('#u-id').value, password: $('#u-pw').value, role: $('#u-role').value });
    $('#userForm').reset(); toast('Member added'); USERS = (await api('GET', '/api/meta')).users; render(); await loadUsers();
  } catch (err) { $('#userErr').textContent = err.message; } finally { b.disabled = false; }
});

// ---------- Meta connection (admin) ----------
function when(iso) { return iso ? `${fmt(iso)} (${ago(iso)})` : 'never'; }
async function loadMeta() {
  let m;
  try { m = await api('GET', '/api/admin/meta'); } catch (e) { $('#metaStatus').innerHTML = `<span class="bad">${esc(e.message)}</span>`; return; }
  $('#m-cb').textContent = m.callbackUrl; $('#m-vt').textContent = m.verifyToken;
  $('#m-secret-set').textContent = m.appSecretSet ? '(saved ✓ – leave empty to keep)' : '';
  $('#m-token-set').textContent = m.pageTokenSet ? '(saved ✓ – leave empty to keep)' : '';
  const connected = m.appSecretSet && m.pageTokenSet && m.subscribed === true;
  $('#metaStatus').innerHTML = [
    connected ? `<span class="ok">● Connected to ${esc(m.pageName || 'your Page')}</span> – new form leads arrive in seconds.`
      : `<span class="bad">● Not connected yet</span> – ${!m.appSecretSet ? 'App Secret missing. ' : ''}${!m.pageTokenSet ? 'Page token missing. ' : ''}${m.pageTokenSet && m.subscribed !== true ? 'Page is not subscribed to leads. ' : ''}`,
    `Last notification from Meta: ${esc(when(m.lastEventAt))} · Last lead added: ${esc(when(m.lastLeadAt))}`,
    `Received: ${m.received} · Waiting/retrying: ${m.pending}${m.failed ? ` · <span class="bad">Failed: ${m.failed}</span>` : ''}`,
    m.lastError ? `<span class="bad">Last error:</span> ${esc(m.lastError)}` : '',
    typeof m.subscribed === 'string' ? `<span class="bad">${esc(m.subscribed)}</span>` : '',
  ].filter(Boolean).join('<br>');
}
$('#metaCard').addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copy]'); if (!c) return;
  const t = $('#' + c.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(t); toast('Copied'); } catch (err) { toast('Select the text and copy it'); }
});
$('#metaForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const b = $('#metaSave'); b.disabled = true; $('#metaErr').textContent = '';
  try {
    await api('POST', '/api/admin/meta', { app_secret: $('#m-secret').value.trim(), page_token: $('#m-token').value.trim(), page_id: $('#m-page').value.trim() });
    $('#m-secret').value = ''; $('#m-token').value = ''; toast('Saved'); await loadMeta();
  } catch (err) { $('#metaErr').textContent = err.message; } finally { b.disabled = false; }
});
$('#metaSync').addEventListener('click', async () => {
  const b = $('#metaSync'); b.disabled = true; $('#metaErr').textContent = '';
  try { const r = await api('POST', '/api/admin/meta/sync', { hours: 72 }); toast(`Checked ${r.checked} lead(s) from ${r.forms} form(s), ${r.added} new`); await loadLeads(); await loadMeta(); }
  catch (err) { $('#metaErr').textContent = err.message; } finally { b.disabled = false; }
});

// ---------- boot ----------
(async () => {
  try {
    const s = await api('GET', '/api/setup');
    if (s.needed) { $('#booting').hidden = true; $('#setup').hidden = false; $('#s-code').focus(); return; }
    await start();
  } catch (e) { if ($('#app').hidden && $('#setup').hidden) showLogin(); }
})();
})();
