(function () {
'use strict';
const TZ = 'Asia/Kolkata';
const BUSINESS = ['Shop / Retail', 'Doctor / Clinic / Hospital', 'Restaurant / Cafe / Cloud kitchen', 'Real Estate / Builder',
  'Coaching / School / Education', 'Salon / Spa / Gym / Fitness', 'Manufacturer / Wholesaler / Trader',
  'Hotel / Travel / Tour agency', 'CA / Lawyer / Consultant', 'Other business'];
const NEEDS = ['New website', 'Website redesign', 'Mobile app', 'WhatsApp automation / Bulk SMS', 'Branding / Logo', 'SEO / Digital marketing'];
// The deal path, in order. Nurture and Lost sit beside it.
const PATH = ['New', 'Trying to reach', 'Qualifying', 'Meeting booked', 'Quote sent', 'Negotiation', 'Won'];
const OUTCOME = {
  no_answer: 'No answer', switched_off: 'Switched off', busy: 'Cut the call / Busy', wrong_number: 'Wrong number',
  interested: 'Interested', not_now: 'Not now', not_interested: 'Not interested',
};
const STUCK_DAYS = 7;

let ME = null, STATUSES = [], OPEN = [], TEMPS = ['Hot', 'Warm', 'Cold'], LOST_REASONS = [], BUDGETS = [], RULES = { maxTries: 5, maxCuts: 3, finalTryDays: 30 };
let TYPES = [], USERS = [], LEADS = [];
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

function toast(t, ms) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), ms || 2200); }
function today() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function hourNow() { return Number(new Date().toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false })); }
function addDays(n) { const [y, m, dd] = today().split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); }
function fmt(iso) { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
function fmtDay(s) {
  if (!s) return '';
  if (s === today()) return 'Today';
  if (s === addDays(1)) return 'Tomorrow';
  return new Date(s + 'T12:00:00+05:30').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: TZ });
}
function fmtTime(t) { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; }
function nextWhen(l) { return l.follow_up ? fmtDay(l.follow_up) + (l.follow_time ? ' ' + fmtTime(l.follow_time) : '') : ''; }
function ago(iso) { const m = (Date.now() - new Date(iso)) / 60000; if (m < 60) return Math.max(1, Math.round(m)) + ' min'; const h = m / 60; if (h < 24) return Math.round(h) + ' h'; return Math.round(h / 24) + ' d'; }
function inr(n) { return n ? '₹' + Number(n).toLocaleString('en-IN') : ''; }
function wa(p) { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d; }
function isOpen(l) { return l.status !== 'Won' && l.status !== 'Lost'; }
/** An Unreachable lead comes back once, 30 days later, for a final try. */
function isFinalTry(l) { return l.status === 'Lost' && l.lost_reason === 'Unreachable' && !!l.follow_up; }
function isDue(l) { return !!l.follow_up && l.follow_up <= today() && (isOpen(l) || isFinalTry(l)); }
function daysInStage(l) { return l.stage_at ? Math.floor((Date.now() - new Date(l.stage_at)) / 864e5) : 0; }
function isStuck(l) { return isOpen(l) && l.status !== 'New' && l.status !== 'Nurture' && daysInStage(l) > STUCK_DAYS; }
/** Short "where is this lead" text, e.g. "Trying to reach · try 2/5" or "Lost · Budget too low". */
function stageText(l) {
  if (l.status === 'Trying to reach') return `Trying to reach · try ${l.call_attempts || 1}/${RULES.maxTries}`;
  if (l.status === 'Lost') return isFinalTry(l) ? 'Lost · final try ' + fmtDay(l.follow_up) : 'Lost' + (l.lost_reason ? ' · ' + l.lost_reason : '');
  if (isOpen(l) && l.status !== 'New' && l.last_call === 'not_connected' && l.call_attempts) return `${l.status} · no answer ×${l.call_attempts}`;
  return l.status;
}
function sCls(s) { return 's-' + String(s).replace(/\s+/g, '-'); }
function stagePill(l) { return `<span class="pill ${sCls(l.status)}">${esc(stageText(l))}</span>`; }
function stuckPill(l) { return isStuck(l) ? `<span class="pill stuck" title="No progress for ${daysInStage(l)} days">Stuck ${daysInStage(l)} d</span>` : ''; }
/** The deal path with the lead's position: New → Trying to reach → … → Won (Nurture / Lost shown at the end). */
function stageTrack(l) {
  const cur = PATH.indexOf(l.status);
  const steps = PATH.map((s, i) => {
    let c = '';
    if (cur >= 0 && i < cur) c = 'done';
    if (i === cur) c = s === 'Won' ? 'k-won' : 'k-cur';
    return [s, c];
  });
  if (l.status === 'Nurture') steps.push(['Nurture · check back ' + fmtDay(l.follow_up), 'k-nur']);
  if (l.status === 'Lost') steps.push([stageText(l), 'k-bad']);
  return `<div class="track-wrap"><ol class="track" aria-label="Deal stage">${steps.map(([t, c], i) =>
    `<li class="${c ? 'reached' : ''}"><span class="step ${c}"${c === 'k-cur' ? ' aria-current="step"' : ''}><i>${i < PATH.length ? i + 1 : '•'}</i>${esc(t)}</span></li>`).join('')}</ol></div>`;
}
function userOptions(sel, withNone) {
  return (withNone ? '<option value="">Unassigned</option>' : '') +
    USERS.map((u) => `<option value="${u.id}" ${String(u.id) === String(sel) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
}
/** Ready-made WhatsApp messages so nobody has to type the same intro 40 times a day. */
function waText(kind, l) {
  const first = String(l.name || '').trim().split(/\s+/)[0] || 'there';
  const me = String(ME.name || '').trim().split(/\s+/)[0];
  const need = l.need ? l.need.charAt(0).toLowerCase() + l.need.slice(1) : 'website';
  if (kind === 'busy') return `Sorry to disturb you, ${first}! This is ${me} from Trata Digital about your ${need} enquiry on Instagram. When can I call you at a better time?`;
  if (kind === 'details') return `Hi ${first}, thank you for your time today! This is ${me} from Trata Digital. As discussed, I'm sharing the details for your ${need} here. Talk soon!`;
  return `Hi ${first}, this is ${me} from Trata Digital about your ${need} enquiry on Instagram. I tried calling you. When is a good time to talk?`;
}
function waLink(kind, l) { const w = wa(l.phone); return w ? `https://wa.me/${w}?text=${encodeURIComponent(waText(kind, l))}` : ''; }

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
  ME = meta.me; STATUSES = meta.statuses; OPEN = meta.openStages || []; TEMPS = meta.temperatures || TEMPS;
  LOST_REASONS = meta.lostReasons || []; BUDGETS = meta.budgets || []; RULES = meta.rules || RULES;
  TYPES = meta.activityTypes; USERS = meta.users;
  $('#gate').hidden = true; $('#setup').hidden = true; $('#booting').hidden = true; $('#app').hidden = false;
  $('#userBtn').textContent = ME.name + ' ▾';
  $('#teamTab').hidden = ME.role !== 'admin'; $('#exportBtn').hidden = ME.role !== 'admin';
  $('#fStatus').innerHTML = '<option value="">All stages</option><option value="__open">All open (still working)</option>' + STATUSES.map((s) => `<option>${esc(s)}</option>`).join('');
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

const RANK = { Hot: 0, Warm: 1, Cold: 2 };
const byHotThenOld = (a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3) || a.received_at.localeCompare(b.received_at);
const byWhen = (a, b) => a.follow_up.localeCompare(b.follow_up) || (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3) || (a.follow_time || '99').localeCompare(b.follow_time || '99');

function renderDash() {
  const L = LEADS, t = today(), month = t.slice(0, 7);
  const fresh = L.filter((l) => l.status === 'New');
  const overdue = L.filter((l) => isDue(l) && l.follow_up < t).sort(byWhen);
  const dueToday = L.filter((l) => isDue(l) && l.follow_up === t).sort(byWhen);
  const meetings = dueToday.filter((l) => l.status === 'Meeting booked').length;
  const stuck = L.filter(isStuck).length;
  const pipeline = L.filter((l) => l.status === 'Quote sent' || l.status === 'Negotiation').reduce((s, l) => s + (l.deal_value || 0), 0);
  const wonMonth = L.filter((l) => l.status === 'Won' && String(l.stage_at || '').slice(0, 7) === month);
  const won = L.filter((l) => l.status === 'Won').length, lost = L.filter((l) => l.status === 'Lost').length;
  const rate = won + lost ? Math.round((won / (won + lost)) * 100) + '%' : '—';
  const tiles = [
    ['New · call now', fresh.length, fresh.length ? 'fresh' : '', 'New'],
    ['Overdue', overdue.length, overdue.length ? 'alert' : '', 'due'],
    ['Due today', dueToday.length, dueToday.length ? 'nc' : '', 'due'],
    ['Meetings today', meetings, meetings ? 'hot' : '', 'Meeting booked'],
    ['Stuck > 7 days', stuck, stuck ? 'alert' : '', 'stuck'],
    ['Pipeline (quotes)', inr(pipeline) || '₹0', '', 'board'],
    ['Won this month', wonMonth.length + (wonMonth.length ? ' · ' + inr(wonMonth.reduce((s, l) => s + (l.deal_value || 0), 0)) : ''), 'good', 'Won'],
    ['Win rate', rate, '', ''],
  ];
  $('#kpis').innerHTML = tiles.map(([l, v, c, go]) => go
    ? `<button class="kpi ${c}" type="button" data-go="${go}"><b>${esc(v)}</b><span>${l}</span></button>`
    : `<div class="kpi ${c}"><b>${esc(v)}</b><span>${l}</span></div>`).join('');

  const row = (l, why) => `<button class="todo-row" type="button" data-id="${l.id}">
      <span class="pill p-${esc(l.priority)}">${esc(l.priority)}</span>
      <span class="todo-main"><strong>${esc(l.name || 'Unnamed')}</strong><small>${esc(why)}${l.assigned_name ? ' · ' + esc(l.assigned_name) : ''}</small></span>
      ${stagePill(l)}</button>`;
  const section = (title, cls, list, why) => list.length
    ? `<div class="todo-sec ${cls}"><h3>${title} <span>${list.length}</span></h3>${list.slice(0, 15).map((l) => row(l, why(l))).join('')}${list.length > 15 ? `<small class="more-n">+ ${list.length - 15} more</small>` : ''}</div>` : '';
  const nextWhat = (l) => l.status === 'Meeting booked' ? 'Meeting' : isFinalTry(l) ? 'Final try' : l.status === 'Trying to reach' ? 'Try again' : l.status === 'Nurture' ? 'Check back' : 'Follow up';
  const html = [
    section('🔴 Call now · new leads', 's-new', fresh.slice().sort(byHotThenOld), (l) => `Waiting ${ago(l.received_at)}${l.need ? ' · ' + l.need : ''}`),
    section('⏰ Overdue', 's-over', overdue, (l) => `${nextWhat(l)} · was due ${nextWhen(l)}${l.last_remark ? ' · “' + l.last_remark + '”' : ''}`),
    section('📅 Today', 's-today', dueToday, (l) => `${nextWhat(l)}${l.follow_time ? ' at ' + fmtTime(l.follow_time) : ''}${l.last_remark ? ' · “' + l.last_remark + '”' : ''}`),
  ].join('');
  $('#todo').innerHTML = html || '<div class="empty">All caught up. No new leads waiting and nothing due today.</div>';

  const funnel = PATH.concat(['Nurture']);
  const max = Math.max(1, ...funnel.map((s) => L.filter((l) => l.status === s).length));
  $('#bars').innerHTML = funnel.map((s) => { const n = L.filter((l) => l.status === s).length;
    return `<button class="bar" type="button" data-go="${esc(s)}"><span>${esc(s)}</span><div class="bar-track"><div class="bar-fill ${sCls(s)}" style="width:${(n / max) * 100}%"></div></div><b>${n}</b></button>`; }).join('');
  const reasons = {}; L.filter((l) => l.status === 'Lost').forEach((l) => { const k = l.lost_reason || 'No reason given'; reasons[k] = (reasons[k] || 0) + 1; });
  const rk = Object.entries(reasons).sort((a, b) => b[1] - a[1]); const rm = Math.max(1, ...rk.map((x) => x[1]));
  $('#reasons').innerHTML = rk.length ? rk.map(([k, n]) => `<div class="bar"><span>${esc(k)}</span><div class="bar-track"><div class="bar-fill s-Lost" style="width:${(n / rm) * 100}%"></div></div><b>${n}</b></div>`).join('')
    : '<div class="empty">No lost leads yet.</div>';
  const needs = {}; L.forEach((l) => { const k = l.need || 'Not given'; needs[k] = (needs[k] || 0) + 1; });
  const nk = Object.entries(needs).sort((a, b) => b[1] - a[1]); const nm = Math.max(1, ...nk.map((x) => x[1]));
  $('#needs').innerHTML = nk.length ? nk.map(([k, n]) => `<div class="bar"><span>${esc(k)}</span><div class="bar-track"><div class="bar-fill" style="width:${(n / nm) * 100}%;opacity:.7"></div></div><b>${n}</b></div>`).join('')
    : '<div class="empty">No leads yet.</div>';
}

function filtered() {
  const q = $('#q').value.toLowerCase(), fs = $('#fStatus').value, fp = $('#fPrio').value, fa = $('#fAssigned').value, fd = $('#fDue').value;
  const stOk = (l) => !fs || (fs === '__open' ? isOpen(l) : l.status === fs);
  const dueOk = (l) => !fd || (fd === 'stuck' ? isStuck(l) : isDue(l));
  return LEADS.filter((l) => stOk(l) && (!fp || l.priority === fp) &&
    (!fa || (fa === 'none' ? !l.assigned_to : String(l.assigned_to) === fa)) && dueOk(l) &&
    (!q || [l.name, l.phone, l.need, l.business, l.notes, l.last_remark, l.assigned_name, l.lost_reason].join(' ').toLowerCase().includes(q)));
}
function renderList() {
  const L = filtered();
  $('#count').textContent = L.length + ' of ' + LEADS.length + ' leads';
  $('#rows').innerHTML = L.length ? L.map((l) => `<tr data-id="${l.id}" tabindex="0">
    <td><strong>${esc(l.name || 'Unnamed')}</strong><span class="sub num">${esc(l.phone)}</span></td>
    <td><span class="pill p-${esc(l.priority)}">${esc(l.priority)}</span></td>
    <td>${stagePill(l)} ${stuckPill(l)}${l.last_remark ? `<span class="sub remark-line">${esc(l.last_remark)}</span>` : ''}</td>
    <td class="hide-sm">${esc(l.need || '—')}<span class="sub">${esc(l.business)}${l.deal_value ? ' · ' + inr(l.deal_value) : ''}</span></td>
    <td>${l.follow_up ? `<span class="${isDue(l) ? 'due' : ''}">${esc(nextWhen(l))}</span>` : '—'}</td>
    <td class="hide-sm">${esc(l.assigned_name || '—')}</td>
    <td class="hide-sm">${esc(fmt(l.received_at))}</td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">No leads match these filters.</td></tr>';
}
function renderBoard() {
  const cols = PATH.concat(['Nurture', 'Lost']);
  $('#board').innerHTML = cols.map((s) => {
    const L = LEADS.filter((l) => l.status === s).sort((a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3) || (a.follow_up || '9').localeCompare(b.follow_up || '9'));
    const sum = L.reduce((x, l) => x + (l.deal_value || 0), 0);
    return `<div class="col"><div class="col-h"><span class="col-t ${sCls(s)}">${esc(s)}</span> <span>${L.length}${sum && s !== 'Lost' ? ' · ' + inr(sum) : ''}</span></div>${L.map((l) => `<button class="lead-card" type="button" data-id="${l.id}">
      <strong>${esc(l.name || 'Unnamed')}</strong><small>${esc(l.need || l.business || '')}${l.deal_value ? ' · <b>' + inr(l.deal_value) + '</b>' : ''}</small>${l.last_remark ? `<small class="remark-line">“${esc(l.last_remark)}”</small>` : ''}
      <div class="row"><span class="pill p-${esc(l.priority)}">${esc(l.priority)}</span>${s === 'Trying to reach' ? `<small>try ${l.call_attempts || 1}/${RULES.maxTries}</small>` : ''}${s === 'Lost' && l.lost_reason ? `<small>${esc(l.lost_reason)}</small>` : ''}${l.follow_up ? `<small class="${isDue(l) ? 'due' : ''}">↻ ${esc(nextWhen(l))}</small>` : ''}${stuckPill(l)}${l.assigned_name ? `<small>· ${esc(l.assigned_name)}</small>` : ''}</div></button>`).join('')}</div>`;
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
  const early = l.status === 'New' || l.status === 'Trying to reach';
  const c = { outcome: '', temp: l.priority, next: '', follow: '', time: '', need: l.need || '', budget: l.budget || '', dm: l.decision_maker || '',
    deal: l.deal_value || '', reason: '', remark: '', closing: '', closeDeal: l.deal_value || '', closeReason: '' };
  dr.innerHTML = `<div class="d-head"><div><h3>${esc(l.name || 'Unnamed')}</h3>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap"><span class="pill p-${esc(l.priority)}">${esc(l.priority)}</span>${stagePill(l)}${stuckPill(l)}</div></div>
      <button class="x" type="button" id="dClose" aria-label="Close">&times;</button></div>
    <div class="d-body">
      <div class="contact"><span class="num" style="font-size:15px">${esc(l.phone || 'No phone')}</span>
        ${w ? `<a class="btn primary" href="tel:+${w}">Call</a><a class="btn" href="https://wa.me/${w}" target="_blank" rel="noopener">WhatsApp</a>` : ''}</div>
      ${stageTrack(l)}
      ${l.follow_up && (isOpen(l) || isFinalTry(l)) ? `<div class="nextup ${isDue(l) ? 'is-due' : ''}"><small>Next</small> ${esc(nextWhen(l))}${l.last_outcome ? ` · last call: ${esc(OUTCOME[l.last_outcome] || l.last_outcome)}` : ''}</div>` : ''}
      ${l.last_remark ? `<div class="last-remark"><small>Last remark · ${esc(fmt(l.last_remark_at))}</small><p>${esc(l.last_remark)}</p></div>` : ''}
      ${l.status === 'Won' ? `<div class="wonbox">🎉 Won${l.deal_value ? ' · ' + inr(l.deal_value) : ''}. Hand over to the project team.</div>`
        : `<section class="callbox" aria-labelledby="callTitle"><h2 id="callTitle">${l.status === 'New' ? 'Log first call' : 'Log a call'}</h2><div id="callSteps"></div></section>`}
      <dl class="facts">
        <dt>Needs</dt><dd>${esc(l.need || '—')}</dd>
        <dt>Budget</dt><dd>${esc(l.budget || '—')}</dd>
        <dt>Decision maker</dt><dd>${l.decision_maker === 'yes' ? 'Yes' : l.decision_maker === 'no' ? 'No' : '—'}</dd>
        <dt>Deal value</dt><dd>${esc(inr(l.deal_value) || '—')}</dd>
        <dt>Business</dt><dd>${esc(l.business || '—')}</dd>
        <dt>Wants to start</dt><dd>${esc(l.start || '—')}</dd>
        <dt>Came in</dt><dd>${esc(fmt(l.received_at))} (${esc(ago(l.received_at))} ago)</dd>
        <dt>Source</dt><dd>${esc(l.campaign || l.source || '—')}</dd>
        <dt>In this stage</dt><dd>${daysInStage(l)} day${daysInStage(l) === 1 ? '' : 's'}</dd>
      </dl>
      <details class="more"><summary>Edit details</summary>
      <form class="form" id="dForm">
        <label>Follow-up date<input id="d-follow" type="date" value="${esc(l.follow_up || '')}"></label>
        <label>Time<input id="d-time" type="time" value="${esc(l.follow_time || '')}"></label>
        <label>Lead type<select id="d-prio">${TEMPS.map((t) => `<option ${t === l.priority ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label>Stage (manual fix)<select id="d-status">${STATUSES.map((s) => `<option ${s === l.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        <label>Lost reason<select id="d-reason"><option value="">—</option>${LOST_REASONS.map((r) => `<option ${r === l.lost_reason ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
        <label>Deal value (₹)<input id="d-deal" inputmode="numeric" value="${esc(l.deal_value || '')}" placeholder="e.g. 25000"></label>
        <label>Budget<select id="d-budget"><option value="">—</option>${BUDGETS.map((x) => `<option ${x === l.budget ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
        <label>Decision maker<select id="d-dm"><option value="">—</option><option value="yes" ${l.decision_maker === 'yes' ? 'selected' : ''}>Yes</option><option value="no" ${l.decision_maker === 'no' ? 'selected' : ''}>No</option></select></label>
        <label class="full">Assigned to<select id="d-assigned">${userOptions(l.assigned_to, true)}</select></label>
        <label class="full">Notes<textarea id="d-notes" maxlength="5000" placeholder="Anything to remember…">${esc(l.notes)}</textarea></label>
        <div class="full d-actions"><button class="btn primary" type="submit" id="dSave">Save changes</button><span class="err" id="dErr" role="alert"></span></div>
      </form></details>
      <div><h2>History</h2>
        <form class="addnote" id="dLogForm">
          <select id="d-type" aria-label="Type">${TYPES.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
          <input id="d-log" placeholder="Add a note, e.g. sent quote on WhatsApp" maxlength="2000" aria-label="Activity details">
          <button class="btn" type="submit" id="dLog">Add</button></form>
        <div class="timeline" style="margin-top:12px">${d.activities.length ? d.activities.map((a) => `<div class="t-item t-${esc(String(a.type).replace(/\s+/g, '-'))}"><strong>${esc(a.type)}</strong>${a.details ? ' · ' + esc(a.details) : ''}<small>${esc(a.user_name || 'System')} · ${esc(fmt(a.created_at))}</small></div>`).join('') : '<div class="empty" style="text-align:left;padding:4px 0">No activity yet.</div>'}</div></div>
      ${ME.role === 'admin' ? '<div><button class="linkbtn danger" type="button" id="dDelete">Delete this lead</button></div>' : ''}
    </div>`;

  // ----- guided "log a call" -----
  const NC = ['no_answer', 'switched_off', 'busy'];
  const defaultNext = (o) => o === 'no_answer' ? (hourNow() < 17 ? addDays(0) : addDays(1)) : o === 'switched_off' ? addDays(1) : addDays(2);
  const opt = (field, val, label, cls) => `<button type="button" class="opt ${cls || ''}" data-f="${field}" data-v="${esc(val)}" aria-pressed="${String(c[field]) === String(val)}">${label}</button>`;
  const chips = (list) => `<div class="datebar">${list.map(([n, t]) => `<button type="button" class="chip" data-day="${n}" aria-pressed="${c.follow === addDays(n)}">${t}</button>`).join('')}
      <input type="date" id="c-follow" min="${today()}" value="${esc(c.follow)}" aria-label="Date"></div>`;
  const waBtn = (kind, label) => w ? `<a class="btn wa" href="${esc(waLink(kind, l))}" target="_blank" rel="noopener" data-wa="${kind}">💬 ${label}</a>` : '';
  function drawCall() {
    const box = $('#callSteps'); if (!box) return;
    const o = c.outcome;
    let h = `<div class="q"><span>What happened on the call?</span>
      <div class="grp"><small>📵 Didn't talk</small><div class="seg">${opt('outcome', 'no_answer', 'No answer', 'o-nc')}${opt('outcome', 'switched_off', 'Switched off', 'o-nc')}${opt('outcome', 'busy', 'Cut / Busy', 'o-nc')}${opt('outcome', 'wrong_number', 'Wrong number', 'o-bad')}</div></div>
      <div class="grp"><small>📞 Talked</small><div class="seg">${opt('outcome', 'interested', 'Interested', 'o-ok')}${opt('outcome', 'not_now', 'Not now', 'o-Warm')}${opt('outcome', 'not_interested', 'Not interested', 'o-bad')}</div></div></div>`;
    if (NC.includes(o)) {
      const tryNo = (l.call_attempts || 0) + 1, cuts = (l.cut_count || 0) + (o === 'busy' ? 1 : 0);
      if (l.status === 'Lost') h += `<p class="note">Final try. If they don't answer, the lead stays Lost.</p>`;
      else if (early && cuts >= RULES.maxCuts) h += `<p class="note warn">Cut ${cuts} times → this moves the lead to <b>Lost (Not responding)</b>.</p>`;
      else if (early && tryNo >= RULES.maxTries) h += `<p class="note warn">Try ${tryNo} of ${RULES.maxTries} → this moves the lead to <b>Lost (Unreachable)</b>. It comes back once in ${RULES.finalTryDays} days for a final try.</p>`;
      else {
        h += `<div class="q"><span>Next try ${early ? `· this is try ${tryNo} of ${RULES.maxTries}` : ''}</span>${chips([[0, 'Later today'], [1, 'Tomorrow'], [2, 'In 2 days']])}
          <small class="hint">${o === 'no_answer' ? 'Call again at a different time of day.' : o === 'switched_off' ? 'Phone may be dead or they are travelling. Try tomorrow.' : 'They may be driving or in a meeting. Give them 2 days.'}</small></div>`;
      }
      h += `<div class="q"><span>Send on WhatsApp now</span><div class="seg">${waBtn(o === 'busy' ? 'busy' : 'intro', o === 'busy' ? 'Polite “better time?” message' : 'Intro message')}</div></div>`;
    } else if (o === 'wrong_number') {
      h += `<p class="note">Moves the lead to <b>Lost (Wrong number / Junk)</b>.</p>`;
    } else if (o === 'interested') {
      const late = l.status === 'Quote sent' || l.status === 'Negotiation';
      h += `<div class="q"><span>Lead type</span><div class="seg">${TEMPS.map((t) => opt('temp', t, t, 'o-' + t)).join('')}</div></div>
        <div class="q"><span>Qualify · 4 questions</span>
          <label class="mini-l">1 · What do they need?<input id="c-need" list="needList" value="${esc(c.need)}" placeholder="e.g. website + WhatsApp automation" maxlength="120"></label>
          <datalist id="needList">${NEEDS.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
          <div class="mini-l">2 · Budget<div class="seg">${BUDGETS.map((b) => opt('budget', b, esc(b))).join('')}</div></div>
          <div class="mini-l">3 · Wants to start: <b>${esc(l.start || 'not asked yet')}</b> <small class="hint">(set Hot / Warm / Cold above)</small></div>
          <div class="mini-l">4 · Decision maker?<div class="seg">${opt('dm', 'yes', 'Yes')}${opt('dm', 'no', 'No')}</div></div></div>
        <div class="q"><span>Next step</span><div class="seg">${opt('next', 'callback', 'Call back')}${opt('next', 'meeting', 'Book meeting')}${opt('next', 'quote', 'Send quote')}${late ? opt('next', 'negotiation', 'Negotiating') : ''}</div></div>`;
      if (c.next) {
        h += `<div class="q"><span>${c.next === 'meeting' ? 'Meeting on' : c.next === 'quote' ? 'Follow up on the quote' : 'Next call'}</span>${chips(c.next === 'quote' ? [[2, 'In 2 days'], [3, 'In 3 days'], [7, '1 week']] : [[1, 'Tomorrow'], [2, 'In 2 days'], [3, 'In 3 days'], [7, '1 week']])}
          ${c.next !== 'quote' ? `<label class="mini-l">Time (optional)<input type="time" id="c-time" value="${esc(c.time)}"></label>` : ''}</div>`;
        if (c.next === 'quote' || c.next === 'negotiation') h += `<div class="q"><span>${c.next === 'quote' ? 'Quote amount' : 'Price being discussed'} (₹)</span><input id="c-deal" class="inp" inputmode="numeric" value="${esc(c.deal)}" placeholder="e.g. 25000"></div>`;
        h += `<p class="tip">Fix the next date and time <b>on the call</b>: “I'll send details on WhatsApp now. Can we talk tomorrow at 11?”</p>`;
      }
      h += `<div class="q"><span>Send on WhatsApp</span><div class="seg">${waBtn('details', 'Thanks + details message')}</div></div>`;
    } else if (o === 'not_now') {
      h += `<div class="q"><span>Check back on</span>${chips([[30, '1 month'], [60, '2 months'], [90, '3 months']])}<small class="hint">Moves to Nurture and comes back by itself on that date.</small></div>`;
    } else if (o === 'not_interested') {
      h += `<p class="tip">Before hanging up, ask: <b>“Is it the budget, or is the timing not right?”</b> If it's timing, choose <b>Not now</b> instead.</p>
        <div class="q"><span>Why not?</span><div class="seg">${LOST_REASONS.slice(0, 4).map((r) => opt('reason', r, esc(r), 'o-bad')).join('')}</div></div>`;
    }
    if (o) h += `<div class="q"><span>Remark</span><textarea id="c-remark" maxlength="2000" placeholder="${NC.includes(o) ? 'Anything useful, e.g. said call after 6 pm' : o === 'interested' ? 'What did they say? Business, requirement…' : 'What did they say?'}">${esc(c.remark)}</textarea></div>`;
    const ready = (NC.includes(o)) || o === 'wrong_number' || (o === 'interested' && c.temp && c.next && c.follow) || (o === 'not_now' && c.follow) || (o === 'not_interested' && c.reason);
    h += `<div class="d-actions"><button class="btn primary" type="button" id="cSave" ${ready ? '' : 'disabled'}>Save call</button><span class="err" id="cErr" role="alert"></span></div>`;
    // close the deal
    h += `<div class="closeopts">Deal finished? <button type="button" class="linkbtn won" data-closing="Won">Mark won</button><button type="button" class="linkbtn danger" data-closing="Lost">Mark lost</button></div>`;
    if (c.closing === 'Won') h += `<div class="closebox"><label class="mini-l">Deal amount (₹) · advance received?<input id="x-deal" class="inp" inputmode="numeric" value="${esc(c.closeDeal)}" placeholder="e.g. 30000"></label>
        <div class="d-actions"><button class="btn won-btn" type="button" data-confirm-close="Won">Confirm won</button><button class="linkbtn" type="button" data-closing="">Cancel</button></div></div>`;
    if (c.closing === 'Lost') h += `<div class="closebox"><div class="mini-l">Why was it lost?<div class="seg">${LOST_REASONS.map((r) => opt('closeReason', r, esc(r), 'o-bad')).join('')}</div></div>
        <div class="d-actions"><button class="btn lost-btn" type="button" data-confirm-close="Lost" ${c.closeReason ? '' : 'disabled'}>Confirm lost</button><button class="linkbtn" type="button" data-closing="">Cancel</button></div></div>`;
    box.innerHTML = h;
  }
  drawCall();
  const box = $('#callSteps');
  if (box) {
    box.addEventListener('click', async (e) => {
      const o = e.target.closest('.opt');
      if (o) {
        const f = o.dataset.f, v = o.dataset.v;
        c[f] = f === 'outcome' || f === 'temp' || f === 'next' || f === 'reason' || f === 'closeReason' ? v : (c[f] === v ? '' : v);
        if (f === 'outcome') { c.next = ''; c.follow = NC.includes(v) ? defaultNext(v) : ''; c.time = ''; }
        if (f === 'next' && !c.follow) c.follow = v === 'quote' ? addDays(2) : addDays(1);
        drawCall(); return;
      }
      const dbtn = e.target.closest('[data-day]');
      if (dbtn) { c.follow = addDays(Number(dbtn.dataset.day)); drawCall(); return; }
      const wbtn = e.target.closest('[data-wa]');
      if (wbtn) { api('POST', `/api/leads/${id}/activities`, { type: 'WhatsApp', details: 'Sent ' + (wbtn.dataset.wa === 'details' ? 'thanks + details' : wbtn.dataset.wa === 'busy' ? '“better time?”' : 'intro') + ' message' }).catch(() => {}); return; }
      const cl = e.target.closest('[data-closing]');
      if (cl) { c.closing = cl.dataset.closing; drawCall(); return; }
      const cc = e.target.closest('[data-confirm-close]');
      if (cc) {
        cc.disabled = true;
        try {
          await api('POST', `/api/leads/${id}/close`, { outcome: cc.dataset.confirmClose, deal_value: c.closeDeal, lost_reason: c.closeReason, remark: c.remark });
          toast(cc.dataset.confirmClose === 'Won' ? '🎉 Marked won' : 'Marked lost'); await loadLeads(); openLead(id);
        } catch (err) { $('#cErr').textContent = err.message; cc.disabled = false; }
        return;
      }
      if (e.target.closest('#cSave')) {
        const b = $('#cSave'); b.disabled = true; $('#cErr').textContent = '';
        try {
          const r = await api('POST', `/api/leads/${id}/call`, { outcome: c.outcome, follow_up: c.follow || null, follow_time: c.time, temperature: c.temp,
            next: c.next, need: c.need, budget: c.budget, decision_maker: c.dm, deal_value: c.deal, lost_reason: c.reason, remark: c.remark });
          toast(r.auto || 'Call saved', r.auto ? 5000 : 0); await loadLeads(); openLead(id);
        } catch (err) { $('#cErr').textContent = err.message; b.disabled = false; }
      }
    });
    box.addEventListener('input', (e) => {
      const map = { 'c-remark': 'remark', 'c-follow': 'follow', 'c-time': 'time', 'c-need': 'need', 'c-deal': 'deal', 'x-deal': 'closeDeal' };
      if (map[e.target.id]) c[map[e.target.id]] = e.target.value;
    });
    box.addEventListener('change', (e) => { if (e.target.id === 'c-follow') drawCall(); });
  }

  $('#dClose').onclick = closeAll;
  $('#dForm').onsubmit = async (e) => {
    e.preventDefault(); const b = $('#dSave'); b.disabled = true; $('#dErr').textContent = '';
    try {
      await api('PATCH', '/api/leads/' + id, { status: $('#d-status').value, priority: $('#d-prio').value, follow_up: $('#d-follow').value || null,
        follow_time: $('#d-time').value, lost_reason: $('#d-reason').value, deal_value: $('#d-deal').value, budget: $('#d-budget').value,
        decision_maker: $('#d-dm').value, assigned_to: $('#d-assigned').value || null, notes: $('#d-notes').value });
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
    const g = go.dataset.go;
    if (g === 'board') { setView('board'); return; }
    $('#fStatus').value = ''; $('#fPrio').value = ''; $('#fDue').value = ''; $('#q').value = ''; $('#fAssigned').value = '';
    if (g === 'due' || g === 'stuck') $('#fDue').value = g;
    else $('#fStatus').value = g;
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
