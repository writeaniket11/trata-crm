'use strict';
// First-run setup + Meta real-time webhook, against a fake Graph API.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert/strict');
const { test, before, after } = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trata-meta-test-'));
process.env.DATA_DIR = tmp;
process.env.IMPORT_KEY = 'test-import-key-1234567890';
process.env.SETUP_CODE = 'ABCD1234-EF567890';
process.env.COOKIE_SECURE = 'false';

const APP_SECRET = 'a'.repeat(16) + 'b'.repeat(16);
const PAGE_TOKEN = 'EAAtest-page-token';
const PAGE = { id: '1122334455', name: 'Trata Digital' };
const graphCalls = [];
let failNext = 0;
const lead = (id, name, t) => ({
  id, created_time: t || '2026-09-28T07:30:00+0000', form_id: 'F1', platform: 'ig', campaign_name: 'Reel – Website leads',
  field_data: [
    { name: 'full_name', values: [name] }, { name: 'phone_number', values: ['+919812345678'] },
    { name: 'what_type_of_business_do_you_run?', values: ['restaurant_/_cafe_/_cloud_kitchen'] },
    { name: 'what_do_you_need?', values: ['new_website'] }, { name: 'when_do_you_want_to_start?', values: ['immediately'] },
  ],
});
const graph = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const token = u.searchParams.get('access_token') || new URLSearchParams(body).get('access_token');
    graphCalls.push(`${req.method} ${u.pathname}`);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (token !== PAGE_TOKEN) return send(400, { error: { message: 'Invalid OAuth access token.', code: 190 } });
    const p = u.pathname.replace('/v23.0', '');
    if (p === '/me' && req.method === 'GET') return send(200, PAGE);
    if (p === '/me/accounts') return send(400, { error: { message: '(#100) Tried accessing nonexisting field (accounts) on node type (Page)', code: 100 } });
    if (p === `/${PAGE.id}/subscribed_apps` && req.method === 'POST') return send(200, { success: true });
    if (p === `/${PAGE.id}/subscribed_apps`) return send(200, { data: [{ name: 'TRATA CRM', subscribed_fields: ['leadgen'] }] });
    if (p === `/${PAGE.id}/leadgen_forms`) return send(200, { data: [{ id: 'F1', name: 'Website form', status: 'ACTIVE' }] });
    if (p === '/F1/leads') return send(200, { data: [lead('POLL1', 'Polled Person'), lead('WH1', 'Asha Webhook')], paging: { cursors: { after: 'x' } } });
    if (p.startsWith('/WH') || p.startsWith('/POLL')) {
      if (failNext > 0) { failNext--; return send(500, { error: { message: 'Temporary Meta error', code: 2 } }); }
      const id = p.slice(1);
      return send(200, lead(id, id === 'WH1' ? 'Asha Webhook' : 'Ravi Webhook'));
    }
    send(404, { error: { message: 'Unknown path ' + p, code: 803 } });
  });
});

let app, db, meta, server, base, cookie = '';
before(async () => {
  await new Promise((r) => graph.listen(0, '127.0.0.1', r));
  process.env.GRAPH_BASE = `http://127.0.0.1:${graph.address().port}`;
  app = require('../src/server'); db = require('../src/db'); meta = require('../src/meta');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); graph.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, { method, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TRATA-CRM', ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await res.text(); let j = t; try { j = JSON.parse(t); } catch (e) { /* text */ }
  return { status: res.status, body: j };
}
const sign = (raw, secret = APP_SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const hook = (ids) => JSON.stringify({ object: 'page', entry: [{ id: PAGE.id, time: 1, changes: ids.map((id) => ({ field: 'leadgen', value: { leadgen_id: id, page_id: PAGE.id, form_id: 'F1' } })) }] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const leadByExt = (id) => db.prepare('SELECT * FROM leads WHERE external_id = ?').get(id);

test('first-run setup creates the admin once', async () => {
  assert.deepEqual((await call('GET', '/api/setup')).body, { needed: true });
  assert.equal((await call('POST', '/api/setup', { code: 'WRONG', name: 'A', username: 'aniket', password: 'secret-pass-1' })).status, 401);
  assert.equal((await call('POST', '/api/setup', { code: process.env.SETUP_CODE, name: 'Aniket', username: 'aniket', password: 'short' })).status, 400);
  const ok = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, name: 'Aniket', username: 'Aniket', password: 'secret-pass-1' });
  assert.equal(ok.status, 201);
  assert.equal((await call('GET', '/api/auth/me')).body.user.role, 'admin');
  assert.deepEqual((await call('GET', '/api/setup')).body, { needed: false });
  assert.equal((await call('POST', '/api/setup', { code: process.env.SETUP_CODE, name: 'X', username: 'hacker', password: 'secret-pass-1' })).status, 403);
});

test('webhook verification handshake', async () => {
  const st = (await call('GET', '/api/admin/meta')).body;
  assert.match(st.verifyToken, /^[a-f0-9]{36}$/);
  assert.equal(st.callbackUrl, `${base}/api/meta/webhook`);
  const good = await call('GET', `/api/meta/webhook?hub.mode=subscribe&hub.verify_token=${st.verifyToken}&hub.challenge=987654`);
  assert.equal(good.status, 200); assert.equal(good.body, 987654);
  assert.equal((await call('GET', '/api/meta/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403);
});

test('admin connects Meta: bad secret, bad token, then good', async () => {
  assert.equal((await call('POST', '/api/admin/meta', { app_secret: 'too-short' })).status, 400);
  const bad = await call('POST', '/api/admin/meta', { page_token: 'wrong' });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /Invalid OAuth/);
  const ok = await call('POST', '/api/admin/meta', { app_secret: APP_SECRET, page_token: PAGE_TOKEN });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.pageName, 'Trata Digital');
  assert.ok(graphCalls.includes(`POST /v23.0/${PAGE.id}/subscribed_apps`), 'page subscribed to leadgen');
  const st = (await call('GET', '/api/admin/meta')).body;
  assert.equal(st.subscribed, true); assert.equal(st.appSecretSet, true);
  assert.equal(JSON.stringify(st).includes(PAGE_TOKEN) || JSON.stringify(st).includes(APP_SECRET), false, 'secrets never sent to browser');
});

test('webhook: unsigned rejected, signed lead lands in CRM within a second', async () => {
  const raw = hook(['WH1']);
  assert.equal((await call('POST', '/api/meta/webhook', raw, { 'X-Hub-Signature-256': sign(raw, 'c'.repeat(32)) })).status, 403);
  assert.equal((await call('POST', '/api/meta/webhook', raw)).status, 403);
  const t0 = Date.now();
  assert.equal((await call('POST', '/api/meta/webhook', raw, { 'X-Hub-Signature-256': sign(raw) })).status, 200);
  let l; for (let i = 0; i < 20 && !(l = leadByExt('WH1')); i++) await wait(50);
  assert.ok(l, 'lead created'); console.log(`   lead appeared ${Date.now() - t0} ms after the webhook`);
  assert.equal(l.name, 'Asha Webhook'); assert.equal(l.phone, '+919812345678');
  assert.equal(l.business, 'Restaurant / cafe / cloud kitchen'); assert.equal(l.need, 'New website');
  assert.equal(l.start, 'Immediately'); assert.equal(l.priority, 'Hot');
  assert.equal(l.source, 'Instagram Lead Form'); assert.equal(l.campaign, 'Reel – Website leads');
  // Meta retries the same notification → still one lead
  await call('POST', '/api/meta/webhook', raw, { 'X-Hub-Signature-256': sign(raw) }); await wait(200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE external_id='WH1'").get().n, 1);
});

test('Meta outage: lead is retried, not lost', async () => {
  failNext = 1;
  const raw = hook(['WH2']);
  await call('POST', '/api/meta/webhook', raw, { 'X-Hub-Signature-256': sign(raw) }); await wait(300);
  assert.equal(leadByExt('WH2'), undefined);
  const ev = db.prepare("SELECT * FROM meta_events WHERE leadgen_id='WH2'").get();
  assert.equal(ev.status, 'pending'); assert.match(ev.last_error, /Temporary Meta error/);
  db.prepare("UPDATE meta_events SET next_try = 0 WHERE leadgen_id='WH2'").run();
  await meta.processPending();
  assert.equal(leadByExt('WH2').name, 'Ravi Webhook');
  assert.equal(db.prepare("SELECT status FROM meta_events WHERE leadgen_id='WH2'").get().status, 'done');
});

test('Google Sheet copy of a Meta lead is not duplicated', async () => {
  const r = await fetch(base + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Import-Key': process.env.IMPORT_KEY },
    body: JSON.stringify({ leads: [{ lead_id: 'WH1', name: 'Asha Webhook', start: 'Immediately' }] }) }).then((x) => x.json());
  assert.deepEqual(r, { received: 1, added: 0, skipped: 1 });
});

test('"Fetch from Meta" safety net pulls missed leads', async () => {
  const r = await call('POST', '/api/admin/meta/sync', { hours: 72 });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { checked: 2, added: 1, forms: 1 });
  assert.equal(leadByExt('POLL1').name, 'Polled Person');
});

test('live version changes when a lead arrives', async () => {
  const v1 = (await call('GET', '/api/leads/version')).body.version;
  const raw = hook(['WH3']);
  await call('POST', '/api/meta/webhook', raw, { 'X-Hub-Signature-256': sign(raw) }); await wait(300);
  const v2 = (await call('GET', '/api/leads/version')).body;
  assert.notEqual(v2.version, v1); assert.equal(v2.max_id, leadByExt('WH3').id);
});

test('privacy page is public', async () => {
  const r = await fetch(base + '/privacy.html'); assert.equal(r.status, 200); assert.match(await r.text(), /Privacy Policy/);
});
