'use strict';
/**
 * Meta (Facebook / Instagram) Lead Ads → CRM in real time.
 *
 * 1. Meta calls POST /api/meta/webhook within seconds of a form being submitted.
 *    We check the signature (App Secret), save the lead ID in meta_events and reply 200 at once.
 * 2. We then fetch the lead's answers from the Graph API with the Page access token and add it.
 *    Failures are retried with back-off, so a short outage never loses a lead.
 * 3. As a safety net, every 10 minutes we also ask Meta for the latest leads of every form
 *    (only works if the token may list forms; the webhook alone is enough otherwise).
 */
const crypto = require('crypto');
const db = require('./db');
const { getSetting, setSetting } = db;

const GRAPH = () => (process.env.GRAPH_BASE || 'https://graph.facebook.com') + '/' + (process.env.GRAPH_VERSION || 'v23.0');
const LEAD_FIELDS_FULL = 'id,created_time,field_data,campaign_name,ad_name,form_id,platform,is_organic';
const LEAD_FIELDS_BASIC = 'id,created_time,field_data,form_id';

let insertLead = null; // injected by server.js
function init(fn) {
  insertLead = fn;
  if (!getSetting('meta_verify_token')) setSetting('meta_verify_token', crypto.randomBytes(18).toString('hex'));
}

async function graph(method, path, params = {}, token) {
  const url = new URL(GRAPH() + path);
  const body = new URLSearchParams();
  const all = { ...params, access_token: token || getSetting('meta_page_token') };
  for (const [k, v] of Object.entries(all)) (method === 'GET' ? url.searchParams : body).set(k, v);
  const res = await fetch(url, { method, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(15000) });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || data.error) {
    const e = new Error((data.error && data.error.message) || `Meta replied ${res.status}`);
    e.code = data.error && data.error.code;
    throw e;
  }
  return data;
}

/** Turn Meta's field_data into our lead fields. Works with any question wording. */
function parseLead(g) {
  const f = {};
  for (const x of g.field_data || []) f[String(x.name || '').toLowerCase()] = (x.values || [])[0] || '';
  const find = (...words) => { const k = Object.keys(f).find((key) => words.some((w) => key.includes(w))); return k ? f[k] : ''; };
  const name = f.full_name || [f.first_name, f.last_name].filter(Boolean).join(' ') || find('name');
  return {
    lead_id: g.id,
    created_time: g.created_time,
    name,
    phone: f.phone_number || find('phone', 'mobile', 'whatsapp'),
    business: find('business'),
    need: find('need', 'service', 'looking'),
    start: find('start', 'when'),
    campaign: g.campaign_name || (g.is_organic ? 'Organic' : '') || 'Meta Lead Ad',
    source: g.platform === 'ig' ? 'Instagram Lead Form' : g.platform === 'fb' ? 'Facebook Lead Form' : 'Meta Lead Form',
  };
}

async function fetchLead(id) {
  try { return await graph('GET', '/' + id, { fields: LEAD_FIELDS_FULL }); } catch (e) {
    // campaign/ad names need extra permission – fall back to the answers only
    if (e.code === 100 || e.code === 200 || /permission|field/i.test(e.message)) return graph('GET', '/' + id, { fields: LEAD_FIELDS_BASIC });
    throw e;
  }
}

/** Verify X-Hub-Signature-256 against the App Secret. */
function validSignature(raw, header) {
  const secret = getSetting('meta_app_secret');
  if (!secret || !raw || !header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

function queueFromWebhook(body) {
  let n = 0;
  const ins = db.prepare('INSERT OR IGNORE INTO meta_events (leadgen_id, page_id) VALUES (?, ?)');
  for (const entry of (body && body.entry) || []) {
    for (const ch of entry.changes || []) {
      if (ch.field !== 'leadgen' || !ch.value || !ch.value.leadgen_id) continue;
      n += ins.run(String(ch.value.leadgen_id), String(ch.value.page_id || entry.id || '')).changes;
    }
  }
  setSetting('meta_last_event_at', new Date().toISOString());
  return n;
}

let running = false;
async function processPending() {
  if (running || !getSetting('meta_page_token')) return;
  running = true;
  try {
    const rows = db.prepare("SELECT * FROM meta_events WHERE status = 'pending' AND next_try <= ? ORDER BY created_at LIMIT 50").all(Date.now());
    for (const ev of rows) {
      try {
        const g = await fetchLead(ev.leadgen_id);
        insertLead(parseLead(g));
        db.prepare("UPDATE meta_events SET status = 'done', attempts = attempts + 1, last_error = '' WHERE leadgen_id = ?").run(ev.leadgen_id);
        setSetting('meta_last_lead_at', new Date().toISOString());
        setSetting('meta_last_error', '');
      } catch (e) {
        const attempts = ev.attempts + 1;
        const status = attempts >= 12 ? 'failed' : 'pending';
        const wait = Math.min(60 * 60e3, 30e3 * 2 ** (attempts - 1)); // 30s, 1m, 2m … max 1h
        db.prepare('UPDATE meta_events SET status = ?, attempts = ?, next_try = ?, last_error = ? WHERE leadgen_id = ?')
          .run(status, attempts, Date.now() + wait, e.message.slice(0, 300), ev.leadgen_id);
        setSetting('meta_last_error', `${new Date().toISOString()} · ${e.message.slice(0, 300)}`);
      }
    }
  } finally { running = false; }
}

/** Safety net: pull leads from the last `hours` hours straight from every form. */
async function pollRecent(hours = 24) {
  const pageId = getSetting('meta_page_id');
  if (!pageId || !getSetting('meta_page_token')) return { checked: 0, added: 0 };
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const forms = await graph('GET', `/${pageId}/leadgen_forms`, { fields: 'id,name,status', limit: '100' });
  let checked = 0, added = 0;
  for (const form of forms.data || []) {
    let next = null;
    let page = await graph('GET', `/${form.id}/leads`, { fields: LEAD_FIELDS_BASIC, limit: '100',
      filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: since }]) });
    for (let guard = 0; guard < 20; guard++) {
      for (const g of page.data || []) { checked++; if (insertLead(parseLead(g))) added++; }
      next = page.paging && page.paging.cursors && page.paging.next ? page.paging.cursors.after : null;
      if (!next) break;
      page = await graph('GET', `/${form.id}/leads`, { fields: LEAD_FIELDS_BASIC, limit: '100', after: next,
        filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: since }]) });
    }
  }
  setSetting('meta_last_poll_at', new Date().toISOString());
  if (added) setSetting('meta_last_lead_at', new Date().toISOString());
  return { checked, added, forms: (forms.data || []).length };
}

/** Save the Page token: check it, remember the Page, subscribe the Page to lead notifications. */
async function connectPage(token, wantedPageId) {
  const me = await graph('GET', '/me', { fields: 'id,name' }, token);
  // A Page token returns the Page itself. A user/system-user token needs a page list.
  let page = me, pageToken = token;
  const accounts = await graph('GET', '/me/accounts', { fields: 'id,name,access_token', limit: '100' }, token).catch(() => null);
  if (accounts && accounts.data && accounts.data.length) {
    const wanted = wantedPageId || getSetting('meta_page_id');
    const p = accounts.data.find((x) => x.id === wanted) || accounts.data[0];
    if (wantedPageId && p.id !== wantedPageId) throw new Error('This token has no access to Page ' + wantedPageId);
    page = { id: p.id, name: p.name }; pageToken = p.access_token || token;
  } else if (wantedPageId && me.id !== wantedPageId) {
    throw new Error('This token belongs to "' + me.name + '", not Page ' + wantedPageId);
  }
  await graph('POST', `/${page.id}/subscribed_apps`, { subscribed_fields: 'leadgen' }, pageToken);
  setSetting('meta_page_token', pageToken);
  setSetting('meta_page_id', page.id);
  setSetting('meta_page_name', page.name || '');
  setSetting('meta_last_error', '');
  return page;
}

async function subscriptionStatus() {
  const pageId = getSetting('meta_page_id');
  if (!pageId || !getSetting('meta_page_token')) return null;
  try {
    const r = await graph('GET', `/${pageId}/subscribed_apps`);
    return (r.data || []).some((a) => (a.subscribed_fields || []).includes('leadgen'));
  } catch (e) { return 'error: ' + e.message; }
}

function status() {
  const count = (s) => db.prepare('SELECT COUNT(*) AS n FROM meta_events WHERE status = ?').get(s).n;
  return {
    verifyToken: getSetting('meta_verify_token'),
    appSecretSet: !!getSetting('meta_app_secret'),
    pageTokenSet: !!getSetting('meta_page_token'),
    pageId: getSetting('meta_page_id'),
    pageName: getSetting('meta_page_name'),
    lastEventAt: getSetting('meta_last_event_at'),
    lastLeadAt: getSetting('meta_last_lead_at'),
    lastPollAt: getSetting('meta_last_poll_at'),
    lastError: getSetting('meta_last_error'),
    pending: count('pending'),
    failed: count('failed'),
    received: count('done'),
  };
}

function start() {
  setInterval(() => processPending().catch(() => {}), 30e3).unref();
  setInterval(() => pollRecent(2).catch((e) => setSetting('meta_last_poll_error', e.message)), 10 * 60e3).unref();
}

module.exports = { init, start, validSignature, queueFromWebhook, processPending, pollRecent, connectPage, subscriptionStatus, status, parseLead };
