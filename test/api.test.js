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
  assert.equal(asha.status, 'New');
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
  const r = await admin('PATCH', `/api/leads/${leadId}`, { status: 'Trying to reach', follow_up: '2026-09-30', assigned_to: memberId, notes: 'Called, wants quote' });
  assert.equal(r.status, 200);
  assert.equal(r.body.lead.status, 'Trying to reach');
  assert.ok(r.body.lead.stage_at, 'stage change records when');
  assert.equal(r.body.lead.assigned_name, 'Prashant');
  assert.equal((await admin('POST', `/api/leads/${leadId}/activities`, { type: 'Call', details: 'Spoke 5 min' })).status, 201);
  assert.equal((await admin('POST', `/api/leads/${leadId}/activities`, { type: 'Call', details: '  ' })).status, 400);
  const d = await admin('GET', `/api/leads/${leadId}`);
  const types = d.body.activities.map((a) => a.type);
  for (const t of ['Lead came in', 'Status', 'Follow-up', 'Assigned', 'Notes updated', 'Call']) assert.ok(types.includes(t), t);
  // no-op patch logs nothing new
  const before = d.body.activities.length;
  await admin('PATCH', `/api/leads/${leadId}`, { status: 'Trying to reach' });
  assert.equal((await admin('GET', `/api/leads/${leadId}`)).body.activities.length, before);
  // Lost needs a reason; deal value / budget / decision maker validate
  assert.equal((await admin('PATCH', `/api/leads/${leadId}`, { status: 'Lost' })).status, 400);
  assert.equal((await admin('PATCH', `/api/leads/${leadId}`, { deal_value: 'abc' })).status, 400);
  assert.equal((await admin('PATCH', `/api/leads/${leadId}`, { budget: 'lots' })).status, 400);
  const ok = await admin('PATCH', `/api/leads/${leadId}`, { deal_value: '25,000', budget: '₹15k–50k', decision_maker: 'yes' });
  assert.equal(ok.body.lead.deal_value, 25000);
  assert.equal(ok.body.lead.budget, '₹15k–50k');
});

const newLead = async (name, extra = {}) => (await admin('POST', '/api/leads', { name, phone: '9811111111', ...extra })).body.lead;
const call = (id, body) => admin('POST', `/api/leads/${id}/call`, body);
const istDay = (n = 0) => {
  const t = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [y, m, d] = t.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

test('call flow: validation', async () => {
  const l = await newLead('Validation');
  assert.equal(l.status, 'New');
  assert.equal((await call(l.id, {})).status, 400);
  assert.equal((await call(l.id, { outcome: 'connected' })).status, 400);
  assert.equal((await call(l.id, { outcome: 'interested' })).status, 400, 'needs temperature');
  assert.equal((await call(l.id, { outcome: 'interested', temperature: 'Hot' })).status, 400, 'needs next step');
  assert.equal((await call(l.id, { outcome: 'interested', temperature: 'Hot', next: 'callback' })).status, 400, 'needs a date');
  assert.equal((await call(l.id, { outcome: 'not_now' })).status, 400, 'needs a check-back date');
  assert.equal((await call(l.id, { outcome: 'not_interested' })).status, 400, 'needs a reason');
  assert.equal((await call(l.id, { outcome: 'no_answer', follow_up: '1-10-2026' })).status, 400);
  assert.equal((await call(l.id, { outcome: 'no_answer', follow_up: '2020-01-01' })).status, 400, 'no past dates');
});

test('call flow: the five calls from the sales floor', async () => {
  // 1) "Not interested" → Lost with a reason
  const a = await newLead('Says no');
  let r = await call(a.id, { outcome: 'not_interested', lost_reason: 'Budget too low', remark: 'Too costly' });
  assert.equal(r.status, 200);
  assert.equal(r.body.lead.status, 'Lost');
  assert.equal(r.body.lead.lost_reason, 'Budget too low');
  assert.equal(r.body.lead.follow_up, null);

  // 2) "Looking for this and that" → Interested, qualify, next step
  const b = await newLead('Wants website');
  r = await call(b.id, { outcome: 'interested', temperature: 'Hot', next: 'callback', follow_up: istDay(1), follow_time: '11:00',
    need: 'Website + WhatsApp automation', budget: '₹15k–50k', decision_maker: 'yes', remark: 'Clothing shop, wants online orders' });
  assert.equal(r.body.lead.status, 'Qualifying');
  assert.equal(r.body.lead.priority, 'Hot');
  assert.equal(r.body.lead.budget, '₹15k–50k');
  assert.equal(r.body.lead.need, 'Website + WhatsApp automation');
  assert.equal(r.body.lead.follow_time, '11:00');
  assert.equal(r.body.lead.ever_connected, 1);
  assert.equal(r.body.lead.assigned_name, 'Admin User', 'first caller owns the lead');
  r = await call(b.id, { outcome: 'interested', temperature: 'Hot', next: 'meeting', follow_up: istDay(2), follow_time: '16:30' });
  assert.equal(r.body.lead.status, 'Meeting booked');
  r = await call(b.id, { outcome: 'interested', temperature: 'Hot', next: 'quote', follow_up: istDay(4), deal_value: '35000' });
  assert.equal(r.body.lead.status, 'Quote sent');
  assert.equal(r.body.lead.deal_value, 35000);
  // a missed follow-up call never moves them backwards
  r = await call(b.id, { outcome: 'no_answer' });
  assert.equal(r.body.lead.status, 'Quote sent');
  assert.equal(r.body.lead.call_attempts, 1);
  r = await call(b.id, { outcome: 'interested', temperature: 'Hot', next: 'negotiation', follow_up: istDay(1), deal_value: 30000 });
  assert.equal(r.body.lead.status, 'Negotiation');
  assert.equal(r.body.lead.call_attempts, 0);
  // won needs an amount
  assert.equal((await admin('POST', `/api/leads/${b.id}/close`, { outcome: 'Won' })).status, 400);
  r = await admin('POST', `/api/leads/${b.id}/close`, { outcome: 'Won', deal_value: '30000', remark: 'Advance paid' });
  assert.equal(r.body.lead.status, 'Won');
  assert.equal(r.body.lead.deal_value, 30000);
  assert.equal(r.body.lead.follow_up, null);
  assert.equal((await call(b.id, { outcome: 'no_answer' })).status, 400, 'no calls on a won deal');
  const hist = (await admin('GET', `/api/leads/${b.id}`)).body.activities;
  assert.ok(hist.some((x) => x.type === 'Won' && x.details === 'Won · ₹30,000 — Advance paid'), hist.map((x) => x.details).join(' | '));
  assert.ok(hist.some((x) => x.type === 'Call' && x.details.startsWith('Interested · Hot · Quote sent ₹35,000')));

  // 3) Didn't pick up → Trying to reach, next try today or tomorrow
  const c = await newLead('No pickup');
  r = await call(c.id, { outcome: 'no_answer' });
  assert.equal(r.body.lead.status, 'Trying to reach');
  assert.equal(r.body.lead.call_attempts, 1);
  assert.ok([istDay(0), istDay(1)].includes(r.body.lead.follow_up));

  // 4) Switched off → next try tomorrow
  const d = await newLead('Phone off');
  r = await call(d.id, { outcome: 'switched_off' });
  assert.equal(r.body.lead.status, 'Trying to reach');
  assert.equal(r.body.lead.follow_up, istDay(1));
  assert.equal(r.body.lead.last_outcome, 'switched_off');

  // 5) Cut the call → next try in 2 days; 3 cuts → Lost (Not responding)
  const e = await newLead('Cuts call');
  r = await call(e.id, { outcome: 'busy' });
  assert.equal(r.body.lead.follow_up, istDay(2));
  assert.equal(r.body.lead.cut_count, 1);
  await call(e.id, { outcome: 'busy' });
  r = await call(e.id, { outcome: 'busy' });
  assert.equal(r.body.lead.status, 'Lost');
  assert.equal(r.body.lead.lost_reason, 'Not responding');
  assert.match(r.body.auto, /Not responding/);
});

test('call flow: 5 tries → Lost (Unreachable) with one final try, wrong number, not now, revive', async () => {
  const l = await newLead('Never answers');
  let r;
  for (let i = 0; i < 4; i++) r = await call(l.id, { outcome: i % 2 ? 'switched_off' : 'no_answer' });
  assert.equal(r.body.lead.status, 'Trying to reach');
  r = await call(l.id, { outcome: 'no_answer' });
  assert.equal(r.body.lead.status, 'Lost');
  assert.equal(r.body.lead.lost_reason, 'Unreachable');
  assert.equal(r.body.lead.follow_up, istDay(30), 'comes back once for a final try');
  // final try connects → back in the pipeline, reason cleared
  r = await call(l.id, { outcome: 'interested', temperature: 'Warm', next: 'callback', follow_up: istDay(3) });
  assert.equal(r.body.lead.status, 'Qualifying');
  assert.equal(r.body.lead.lost_reason, '');

  const w = await newLead('Wrong');
  r = await call(w.id, { outcome: 'wrong_number' });
  assert.equal(r.body.lead.status, 'Lost');
  assert.equal(r.body.lead.lost_reason, 'Wrong number / Junk');

  const n = await newLead('Later');
  r = await call(n.id, { outcome: 'not_now', follow_up: istDay(60), remark: 'After Diwali' });
  assert.equal(r.body.lead.status, 'Nurture');
  assert.equal(r.body.lead.follow_up, istDay(60));
  // lost via close needs a reason
  assert.equal((await admin('POST', `/api/leads/${n.id}/close`, { outcome: 'Lost' })).status, 400);
  r = await admin('POST', `/api/leads/${n.id}/close`, { outcome: 'Lost', lost_reason: 'Chose someone else' });
  assert.equal(r.body.lead.lost_reason, 'Chose someone else');
  // manual lead type change
  assert.equal((await admin('PATCH', `/api/leads/${n.id}`, { priority: 'Lukewarm' })).status, 400);
  assert.equal((await admin('PATCH', `/api/leads/${n.id}`, { priority: 'Warm' })).body.lead.priority, 'Warm');
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
  assert.equal((await m('PATCH', `/api/leads/${leadId}`, { status: 'Qualifying' })).status, 200);
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
