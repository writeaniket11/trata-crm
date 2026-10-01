'use strict';
// End-to-end API tests. Run: npm test
// Uses a throwaway database in a temp folder, never the real data/ folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { test, before, after } = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trata-crm-test-'));
process.env.DATA_DIR = tmp;
process.env.IMPORT_KEY = 'test-import-key-1234567890';
process.env.COOKIE_SECURE = 'false';

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const app = require('../src/server');

let server, base;
before(async () => {
  db.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?,?)')
    .run('admin', 'Admin User', bcrypt.hashSync('admin-pass-123', 4), 'admin');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TRATA-CRM', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
}

const importLeads = (leads, key = process.env.IMPORT_KEY) => fetch(base + '/api/import', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Import-Key': key }, body: JSON.stringify({ leads }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const admin = client();
let memberId, leadId;

test('health and SPA fallback', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/health')).status, 200);
  const page = await anon('GET', '/some/deep/link');
  assert.equal(page.status, 200);
  assert.match(page.body, /TRATA CRM/);
  assert.equal((await anon('GET', '/api/nope')).status, 404);
});

test('protected routes need login', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/leads')).status, 401);
  assert.equal((await anon('GET', '/api/meta')).status, 401);
  assert.equal((await anon('GET', '/api/export.csv')).status, 401);
});

test('login: wrong password, missing CSRF header, success', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: 'admin', password: 'nope' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { username: 'admin', password: 'admin-pass-123' }, { 'X-Requested-With': '' })).status, 403);
  const ok = await admin('POST', '/api/auth/login', { username: 'ADMIN', password: 'admin-pass-123', remember: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'admin');
  const me = await admin('GET', '/api/auth/me');
  assert.equal(me.body.user.username, 'admin');
});

test('import: bad key rejected, leads added, duplicates skipped', async () => {
  assert.equal((await importLeads([{ lead_id: 'x' }], 'wrong')).status, 401);
  const leads = [
    { lead_id: 'L1', created_time: '2026-09-20T10:15:00+0000', campaign: 'Reel', name: 'Asha', phone: '+919800000001', business: 'other_business', need: 'new_website', start: 'immediately' },
    { lead_id: 'L2', created_time: '2026-09-21T11:00:00+0530', campaign: 'Reel', name: 'Ravi', phone: '+919800000002', business: 'restaurant_/_cafe', need: 'branding_/_logo', start: 'just_exploring' },
  ];
  const r1 = await importLeads(leads);
  assert.deepEqual(r1.body, { received: 2, added: 2, skipped: 0 });
  const r2 = await importLeads(leads);
  assert.deepEqual(r2.body, { received: 2, added: 0, skipped: 2 });
  const list = await admin('GET', '/api/leads');
  assert.equal(list.body.leads.length, 2);
  const asha = list.body.leads.find((l) => l.external_id === 'L1');
  assert.equal(asha.priority, 'Hot');
  assert.equal(asha.status, 'Fresh');
  assert.equal(asha.need, 'New website');
  assert.equal(asha.received_at, '2026-09-20T10:15:00.000Z');
  const ravi = list.body.leads.find((l) => l.external_id === 'L2');
  assert.equal(ravi.business, 'Restaurant / cafe');
  assert.equal(ravi.need, 'Branding / Logo');
  assert.equal(ravi.priority, 'Cold');
  assert.equal(ravi.received_at, '2026-09-21T05:30:00.000Z');
  leadId = asha.id;
});

test('users: admin creates member; validation', async () => {
  assert.equal((await admin('POST', '/api/users', { name: 'P', username: 'x', password: '12345678' })).status, 400);
  assert.equal((await admin('POST', '/api/users', { name: 'P', username: 'prashant', password: 'short' })).status, 400);
  const ok = await admin('POST', '/api/users', { name: 'Prashant', username: 'prashant', password: 'member-pass-1', role: 'member' });
  assert.equal(ok.status, 201);
  assert.equal((await admin('POST', '/api/users', { name: 'Dup', username: 'Prashant', password: 'member-pass-1' })).status, 400);
  const users = await admin('GET', '/api/users');
  memberId = users.body.users.find((u) => u.username === 'prashant').id;
  const self = users.body.users.find((u) => u.username === 'admin').id;
  assert.equal((await admin('PATCH', `/api/users/${self}`, { active: false })).status, 400);
  assert.equal((await admin('PATCH', `/api/users/${self}`, { role: 'member' })).status, 400);
});

test('lead update: status, follow-up, assign, notes, activity log', async () => {
  assert.equal((await admin('PATCH', `/api/leads/${leadId}`, { status: 'Bogus' })).status, 400);
  assert.equal((await admin('PATCH', `/api/leads/${leadId}`, { follow_up: '20-09-2026' })).status, 400);
  const r = await admin('PATCH', `/api/leads/${leadId}`, { status: 'Not connected', follow_up: '2026-09-30', assigned_to: memberId, notes: 'Called, wants quote' });
  assert.equal(r.status, 200);
  assert.equal(r.body.lead.status, 'Not connected');
  assert.equal(r.body.lead.assigned_name, 'Prashant');
  assert.equal((await admin('POST', `/api/leads/${leadId}/activities`, { type: 'Call', details: 'Spoke 5 min' })).status, 201);
  assert.equal((await admin('POST', `/api/leads/${leadId}/activities`, { type: 'Call', details: '  ' })).status, 400);
  const d = await admin('GET', `/api/leads/${leadId}`);
  const types = d.body.activities.map((a) => a.type);
  for (const t of ['Lead came in', 'Status', 'Follow-up', 'Assigned', 'Notes updated', 'Call']) assert.ok(types.includes(t), t);
  // no-op patch logs nothing new
  const before = d.body.activities.length;
  await admin('PATCH', `/api/leads/${leadId}`, { status: 'Not connected' });
  assert.equal((await admin('GET', `/api/leads/${leadId}`)).body.activities.length, before);
});

test('call flow: not connected, connected + interested, not interested, close', async () => {
  const r0 = await admin('POST', '/api/leads', { name: 'Flow Test', phone: '9811111111', start: 'just_exploring' });
  const id = r0.body.lead.id;
  assert.equal(r0.body.lead.status, 'Fresh');
  // validation
  assert.equal((await admin('POST', `/api/leads/${id}/call`, {})).status, 400);
  assert.equal((await admin('POST', `/api/leads/${id}/call`, { result: 'connected' })).status, 400);
  assert.equal((await admin('POST', `/api/leads/${id}/call`, { result: 'connected', interest: 'interested' })).status, 400);
  assert.equal((await admin('POST', `/api/leads/${id}/call`, { result: 'not_connected', follow_up: '1-10-2026' })).status, 400);
  // two missed calls
  let r = await admin('POST', `/api/leads/${id}/call`, { result: 'not_connected', follow_up: '2026-10-02', remark: 'Switched off' });
  assert.equal(r.body.lead.status, 'Not connected');
  assert.equal(r.body.lead.call_attempts, 1);
  assert.equal(r.body.lead.follow_up, '2026-10-02');
  assert.equal(r.body.lead.last_remark, 'Switched off');
  r = await admin('POST', `/api/leads/${id}/call`, { result: 'not_connected' });
  assert.equal(r.body.lead.call_attempts, 2);
  assert.equal(r.body.lead.last_remark, 'Switched off', 'empty remark keeps the last one');
  // connected, interested, hot
  r = await admin('POST', `/api/leads/${id}/call`, { result: 'connected', interest: 'interested', temperature: 'Hot', follow_up: '2026-10-05', remark: 'Wants website, budget 25k' });
  assert.equal(r.body.lead.status, 'Interested');
  assert.equal(r.body.lead.priority, 'Hot');
  assert.equal(r.body.lead.call_attempts, 0);
  assert.equal(r.body.lead.ever_connected, 1);
  assert.equal(r.body.lead.follow_up, '2026-10-05');
  // a missed follow-up call keeps them Interested
  r = await admin('POST', `/api/leads/${id}/call`, { result: 'not_connected', remark: 'No answer' });
  assert.equal(r.body.lead.status, 'Interested');
  assert.equal(r.body.lead.last_call, 'not_connected');
  assert.equal(r.body.lead.follow_up, '2026-10-05');
  // close
  assert.equal((await admin('POST', `/api/leads/${id}/close`, { outcome: 'Maybe' })).status, 400);
  r = await admin('POST', `/api/leads/${id}/close`, { outcome: 'Won', remark: 'Advance paid' });
  assert.equal(r.body.lead.status, 'Won');
  assert.equal(r.body.lead.follow_up, null);
  const d = await admin('GET', `/api/leads/${id}`);
  const calls = d.body.activities.filter((a) => a.type === 'Call').map((a) => a.details);
  assert.equal(calls.length, 4);
  assert.ok(calls.some((t) => t === 'Connected · Interested · Hot · Follow-up 2026-10-05 — Wants website, budget 25k'), calls.join(' | '));
  assert.ok(calls.some((t) => t.startsWith('Not connected (try 2)')));
  assert.ok(d.body.activities.some((a) => a.type === 'Won' && a.details === 'Advance paid'));
  // not interested
  const r2 = await admin('POST', '/api/leads', { name: 'No Thanks' });
  r = await admin('POST', `/api/leads/${r2.body.lead.id}/call`, { result: 'connected', interest: 'not_interested', remark: 'Already has a website' });
  assert.equal(r.body.lead.status, 'Not interested');
  // manual lead type change
  assert.equal((await admin('PATCH', `/api/leads/${id}`, { priority: 'Lukewarm' })).status, 400);
  assert.equal((await admin('PATCH', `/api/leads/${id}`, { priority: 'Warm' })).body.lead.priority, 'Warm');
});

test('manual lead create', async () => {
  assert.equal((await admin('POST', '/api/leads', { name: '' })).status, 400);
  const r = await admin('POST', '/api/leads', { name: 'Walk In', phone: '9876543210', start: 'within_1_month', need: 'Mobile app', source: 'Referral', assigned_to: memberId });
  assert.equal(r.status, 201);
  assert.equal(r.body.lead.priority, 'Warm');
  assert.equal(r.body.lead.source, 'Referral');
});

test('member permissions', async () => {
  const m = client();
  assert.equal((await m('POST', '/api/auth/login', { username: 'prashant', password: 'member-pass-1' })).status, 200);
  assert.equal((await m('GET', '/api/leads')).status, 200);
  assert.equal((await m('PATCH', `/api/leads/${leadId}`, { status: 'Interested' })).status, 200);
  assert.equal((await m('GET', '/api/users')).status, 403);
  assert.equal((await m('POST', '/api/users', { name: 'X', username: 'xyz', password: '12345678' })).status, 403);
  assert.equal((await m('DELETE', `/api/leads/${leadId}`)).status, 403);
  assert.equal((await m('GET', '/api/export.csv')).status, 403);
  // member changes own password
  assert.equal((await m('POST', '/api/auth/password', { current: 'wrong', password: 'newpass-999' })).status, 400);
  assert.equal((await m('POST', '/api/auth/password', { current: 'member-pass-1', password: 'newpass-999' })).status, 200);
  assert.equal((await m('GET', '/api/leads')).status, 200, 'current session survives own password change');
  const m2 = client();
  assert.equal((await m2('POST', '/api/auth/login', { username: 'prashant', password: 'newpass-999' })).status, 200);
  // admin deactivates -> sessions die, can't log in
  assert.equal((await admin('PATCH', `/api/users/${memberId}`, { active: false })).status, 200);
  assert.equal((await m('GET', '/api/leads')).status, 401);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'prashant', password: 'newpass-999' })).status, 401);
  assert.equal((await admin('PATCH', `/api/users/${memberId}`, { active: true, password: 'reset-pass-1' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'prashant', password: 'reset-pass-1' })).status, 200);
});

test('csv export escapes formulas', async () => {
  await admin('PATCH', `/api/leads/${leadId}`, { notes: '=HYPERLINK("x")' });
  const r = await admin('GET', '/api/export.csv');
  assert.equal(r.status, 200);
  assert.match(r.body, /"'=HYPERLINK\(""x""\)"/);
  assert.match(r.headers.get('content-disposition'), /trata-leads-/);
});

test('delete lead (admin) and logout', async () => {
  assert.equal((await admin('DELETE', `/api/leads/${leadId}`)).status, 200);
  assert.equal((await admin('GET', `/api/leads/${leadId}`)).status, 404);
  assert.equal((await admin('POST', '/api/auth/logout')).status, 200);
  assert.equal((await admin('GET', '/api/leads')).status, 401);
});
