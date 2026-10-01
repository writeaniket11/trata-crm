'use strict';
/**
 * TRATA CRM – server
 * Node.js + Express + SQLite. Serves the web app from /public and a JSON API under /api.
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { STATUSES, OPEN_STAGES, TEMPERATURES, LOST_REASONS, BUDGETS, MAX_TRIES, MAX_CUTS, FINAL_TRY_DAYS,
  human, priorityFor } = require('./labels');
const { applyCall, rupees, inr } = require('./callflow');
const meta = require('./meta');

const PORT = Number(process.env.PORT || 3000);
const IMPORT_KEY = process.env.IMPORT_KEY || '';
const SETUP_CODE = process.env.SETUP_CODE || '';
const COOKIE = 'trata_sid';
const SECURE_COOKIE = process.env.COOKIE_SECURE !== 'false';
const ACTIVITY_TYPES = ['Note', 'Call', 'WhatsApp', 'Meeting', 'Email'];

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'style-src': ["'self'", 'https://fonts.googleapis.com'],
      'style-src-attr': ["'unsafe-inline'"], // bar widths etc. (scripts stay strictly self-only)
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'script-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/meta/webhook')) req.rawBody = buf; } }));
app.use((req, res, next) => { if (!req.body) req.body = {}; next(); });
app.use(cookieParser());

// ---------- helpers ----------
const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function fail(res, code, message) { return res.status(code).json({ error: message }); }
function clean(v, max = 500) { return String(v === undefined || v === null ? '' : v).trim().slice(0, max); }
function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v); }
function isTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }
// Dates for follow-ups are calendar days in India.
function istToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
function istHour() { return Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false })); }
function validUsername(u) { return /^[a-z0-9._-]{3,30}$/i.test(u); }
function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }

function logActivity(leadId, userId, type, details) {
  db.prepare('INSERT INTO activities (lead_id, user_id, type, details) VALUES (?,?,?,?)')
    .run(leadId, userId || null, type, details || '');
}

function safeEqual(a, b) {
  a = Buffer.from(String(a || '')); b = Buffer.from(String(b || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Add one lead from Meta / the Google Sheet. Returns true if it was new. */
const insLead = db.prepare(`
  INSERT OR IGNORE INTO leads (external_id, received_at, name, phone, business, need, start, priority, status, source, campaign, stage_at)
  VALUES (?,?,?,?,?,?,?,?,'New',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
function insertLead(l) {
  const ext = clean(l.lead_id || l.id, 80);
  if (!ext) return false;
  let received = new Date(String(l.created_time || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  if (isNaN(received)) received = new Date();
  const start = clean(l.start, 60);
  const r = insLead.run(ext, received.toISOString(), clean(l.name, 120), clean(l.phone, 30),
    human(l.business), human(l.need), human(start), priorityFor(start),
    clean(l.source, 60) || 'Instant Form', clean(l.campaign, 200));
  if (r.changes) logActivity(r.lastInsertRowid, null, 'Lead came in', [clean(l.source, 60), clean(l.campaign, 200)].filter(Boolean).join(' · ') || 'Meta Instant Form');
  return !!r.changes;
}
meta.init(insertLead);

const leadSelect = `
  SELECT l.*, u.name AS assigned_name
  FROM leads l LEFT JOIN users u ON u.id = l.assigned_to`;

// ---------- sessions ----------
function createSession(res, userId, remember) {
  const token = crypto.randomBytes(32).toString('hex');
  const days = remember ? 30 : 1;
  const expires = Date.now() + days * 864e5;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE, path: '/',
    maxAge: remember ? days * 864e5 : undefined,
  });
}

function auth(req, res, next) {
  const token = req.cookies[COOKIE];
  if (!token) return fail(res, 401, 'Please log in.');
  const row = db.prepare(`
    SELECT s.expires_at, u.id, u.name, u.username, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token));
  if (!row || row.expires_at < Date.now() || !row.active) {
    if (row) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
    res.clearCookie(COOKIE, { path: '/' });
    return fail(res, 401, 'Your session has ended. Please log in again.');
  }
  req.user = { id: row.id, name: row.name, username: row.username, role: row.role };
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return fail(res, 403, 'Only an admin can do this.');
  next();
}
// Simple CSRF guard: browsers can't send this custom header cross-site without CORS.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'TRATA-CRM') return fail(res, 403, 'Blocked request.');
  next();
}

// ---------- auth routes ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' } });

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- first-run setup (only while there are no users) ----------
const noUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
app.get('/api/setup', (req, res) => res.json({ needed: noUsers() }));
app.post('/api/setup', loginLimiter, sameOrigin, (req, res) => {
  if (!noUsers()) return fail(res, 403, 'Setup is already done. Please log in.');
  if (!SETUP_CODE || !safeEqual(clean(req.body.code, 100), SETUP_CODE)) return fail(res, 401, 'Setup code is wrong.');
  const username = clean(req.body.username, 30).toLowerCase();
  const name = clean(req.body.name, 80);
  if (!name) return fail(res, 400, 'Enter your name.');
  if (!validUsername(username)) return fail(res, 400, 'Login ID: 3–30 letters, numbers, dot, dash or underscore.');
  if (!validPassword(req.body.password)) return fail(res, 400, 'Password must be at least 8 characters.');
  const info = db.prepare("INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?, 'admin')")
    .run(username, name, bcrypt.hashSync(req.body.password, 10));
  createSession(res, info.lastInsertRowid, true);
  res.status(201).json({ user: { id: info.lastInsertRowid, name, username, role: 'admin' } });
});

app.post('/api/auth/login', loginLimiter, sameOrigin, (req, res) => {
  const username = clean(req.body.username, 60).toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !user.active || !bcrypt.compareSync(password, user.password_hash)) {
    return fail(res, 401, 'Wrong login ID or password.');
  }
  createSession(res, user.id, !!req.body.remember);
  res.json({ user: { id: user.id, name: user.name, username: user.username, role: user.role } });
});

app.post('/api/auth/logout', sameOrigin, (req, res) => {
  const token = req.cookies[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));

app.post('/api/auth/password', auth, sameOrigin, (req, res) => {
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.current || ''), u.password_hash)) return fail(res, 400, 'Current password is wrong.');
  if (!validPassword(req.body.password)) return fail(res, 400, 'New password must be at least 8 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 10), req.user.id);
  // sign out other devices
  const token = req.cookies[COOKIE];
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, sha(token));
  res.json({ ok: true });
});

// ---------- meta ----------
app.get('/api/meta', auth, (req, res) => {
  const users = db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all();
  res.json({ statuses: STATUSES, openStages: OPEN_STAGES, temperatures: TEMPERATURES, lostReasons: LOST_REASONS, budgets: BUDGETS,
    rules: { maxTries: MAX_TRIES, maxCuts: MAX_CUTS, finalTryDays: FINAL_TRY_DAYS }, activityTypes: ACTIVITY_TYPES, users, me: req.user });
});

// ---------- leads ----------
app.get('/api/leads', auth, (req, res) => {
  res.json({ leads: db.prepare(`${leadSelect} ORDER BY l.received_at DESC`).all() });
});

app.get('/api/leads/version', auth, (req, res) => {
  const r = db.prepare('SELECT COUNT(*) AS n, MAX(id) AS max_id, MAX(updated_at) AS upd FROM leads').get();
  const a = db.prepare('SELECT MAX(id) AS a FROM activities').get();
  res.json({ version: `${r.n}-${r.max_id}-${r.upd}-${a.a}`, max_id: r.max_id || 0 });
});

app.get('/api/leads/:id', auth, (req, res) => {
  const lead = db.prepare(`${leadSelect} WHERE l.id = ?`).get(req.params.id);
  if (!lead) return fail(res, 404, 'Lead not found.');
  const activities = db.prepare(`
    SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.lead_id = ? ORDER BY a.created_at DESC, a.id DESC`).all(lead.id);
  res.json({ lead, activities });
});

app.post('/api/leads', auth, sameOrigin, (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 120);
  if (!name) return fail(res, 400, 'Name is required.');
  const start = clean(b.start, 60);
  const assigned = b.assigned_to ? Number(b.assigned_to) : null;
  if (assigned && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(assigned)) return fail(res, 400, 'Unknown team member.');
  const info = db.prepare(`
    INSERT INTO leads (received_at, name, phone, business, need, start, priority, status, assigned_to, notes, source, campaign, stage_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    now(), name, clean(b.phone, 30), clean(b.business, 80), clean(b.need, 80), human(start), priorityFor(start),
    'New', assigned, clean(b.notes, 5000), clean(b.source, 60) || 'Manual', clean(b.source, 60) || 'Manual', now());
  logActivity(info.lastInsertRowid, req.user.id, 'Created', `Added manually (${clean(b.source, 60) || 'Manual'})`);
  res.status(201).json({ lead: db.prepare(`${leadSelect} WHERE l.id = ?`).get(info.lastInsertRowid) });
});

app.patch('/api/leads/:id', auth, sameOrigin, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return fail(res, 404, 'Lead not found.');
  const b = req.body || {};
  const sets = [];
  const vals = [];
  const logs = [];

  const reason = 'lost_reason' in b ? clean(b.lost_reason, 60) : lead.lost_reason;
  if (reason && !LOST_REASONS.includes(reason)) return fail(res, 400, 'Unknown lost reason.');
  if ('status' in b && b.status !== lead.status) {
    if (!STATUSES.includes(b.status)) return fail(res, 400, 'Unknown status.');
    if (b.status === 'Lost' && !reason) return fail(res, 400, 'Choose why the lead was lost.');
    sets.push('status = ?', 'stage_at = ?'); vals.push(b.status, now()); logs.push(['Status', `${lead.status} → ${b.status}`]);
    if (b.status !== 'Lost' && lead.lost_reason) { sets.push("lost_reason = ''"); }
    if (b.status === 'Won' || b.status === 'Lost') sets.push('follow_up = NULL');
  }
  if ((b.status || lead.status) === 'Lost' && reason !== lead.lost_reason) {
    sets.push('lost_reason = ?'); vals.push(reason); logs.push(['Lost reason', reason]);
  }
  if ('deal_value' in b) {
    const v = b.deal_value === '' || b.deal_value === null ? null : rupees(b.deal_value);
    if (b.deal_value !== '' && b.deal_value !== null && v === null) return fail(res, 400, 'Deal value should be an amount in ₹.');
    if (v !== lead.deal_value) { sets.push('deal_value = ?'); vals.push(v); logs.push(['Deal value', v ? `₹${v.toLocaleString('en-IN')}` : 'cleared']); }
  }
  if ('budget' in b && clean(b.budget, 30) !== lead.budget) {
    const v = clean(b.budget, 30);
    if (v && !BUDGETS.includes(v)) return fail(res, 400, 'Unknown budget.');
    sets.push('budget = ?'); vals.push(v); logs.push(['Budget', v || 'cleared']);
  }
  if ('decision_maker' in b && clean(b.decision_maker, 3) !== lead.decision_maker) {
    const v = clean(b.decision_maker, 3);
    if (v && !['yes', 'no'].includes(v)) return fail(res, 400, 'Decision maker should be yes or no.');
    sets.push('decision_maker = ?'); vals.push(v); logs.push(['Decision maker', v || 'cleared']);
  }
  if ('follow_time' in b && clean(b.follow_time, 5) !== lead.follow_time) {
    const v = clean(b.follow_time, 5);
    if (v && !isTime(v)) return fail(res, 400, 'Time is not valid.');
    sets.push('follow_time = ?'); vals.push(v);
  }
  if ('priority' in b && b.priority !== lead.priority) {
    if (!TEMPERATURES.includes(b.priority)) return fail(res, 400, 'Lead type must be Hot, Warm or Cold.');
    sets.push('priority = ?'); vals.push(b.priority); logs.push(['Lead type', `${lead.priority} → ${b.priority}`]);
  }
  if ('follow_up' in b && (b.follow_up || null) !== lead.follow_up && !['Won', 'Lost'].includes(b.status || lead.status)) {
    const v = b.follow_up ? String(b.follow_up) : null;
    if (v && !isDate(v)) return fail(res, 400, 'Follow-up date is not valid.');
    sets.push('follow_up = ?'); vals.push(v); logs.push(['Follow-up', v || 'cleared']);
  }
  if ('assigned_to' in b) {
    const v = b.assigned_to ? Number(b.assigned_to) : null;
    if (v !== lead.assigned_to) {
      let who = 'Unassigned';
      if (v) {
        const u = db.prepare('SELECT name FROM users WHERE id = ?').get(v);
        if (!u) return fail(res, 400, 'Unknown team member.');
        who = u.name;
      }
      sets.push('assigned_to = ?'); vals.push(v); logs.push(['Assigned', who]);
    }
  }
  if ('notes' in b && clean(b.notes, 5000) !== lead.notes) {
    sets.push('notes = ?'); vals.push(clean(b.notes, 5000)); logs.push(['Notes updated', '']);
  }
  for (const f of ['name', 'phone', 'business', 'need']) {
    if (f in b && clean(b[f], 120) !== lead[f]) {
      if (f === 'name' && !clean(b[f])) return fail(res, 400, 'Name is required.');
      sets.push(`${f} = ?`); vals.push(clean(b[f], 120)); logs.push(['Edited', f]);
    }
  }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(now());
    db.transaction(() => {
      db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals, lead.id);
      logs.forEach(([t, d]) => logActivity(lead.id, req.user.id, t, d));
    })();
  }
  res.json({ lead: db.prepare(`${leadSelect} WHERE l.id = ?`).get(lead.id) });
});

// ---------- call flow: log one call, or close a lead ----------
// body: { outcome, follow_up, follow_time, temperature, next, need, budget, decision_maker, deal_value, lost_reason, remark }
app.post('/api/leads/:id/call', auth, sameOrigin, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return fail(res, 404, 'Lead not found.');
  const b = req.body || {};
  const r = applyCall(lead, b, { today: istToday(), hour: istHour() });
  if (r.error) return fail(res, 400, r.error);
  const t = now();
  const up = { ...r.up, last_call_at: t, updated_at: t };
  if (up.stage_at) up.stage_at = t;
  const remark = clean(b.remark, 2000);
  if (remark) { up.last_remark = remark; up.last_remark_at = t; }
  if (!lead.assigned_to) up.assigned_to = req.user.id; // whoever calls first owns the lead
  const keys = Object.keys(up);
  db.transaction(() => {
    db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => up[k]), lead.id);
    logActivity(lead.id, req.user.id, 'Call', r.log + (remark ? ` — ${remark}` : ''));
    if (r.auto) logActivity(lead.id, null, 'Auto', r.auto);
  })();
  res.json({ lead: db.prepare(`${leadSelect} WHERE l.id = ?`).get(lead.id), auto: r.auto });
});

// body: { outcome: 'Won'|'Lost', deal_value (Won), lost_reason (Lost), remark }
app.post('/api/leads/:id/close', auth, sameOrigin, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return fail(res, 404, 'Lead not found.');
  const b = req.body || {};
  const outcome = b.outcome;
  if (!['Won', 'Lost'].includes(outcome)) return fail(res, 400, 'Choose Won or Lost.');
  const remark = clean(b.remark, 2000);
  const t = now();
  const up = { status: outcome, stage_at: t, follow_up: null, follow_time: '', updated_at: t };
  let details;
  if (outcome === 'Won') {
    const deal = rupees(b.deal_value);
    if (!deal) return fail(res, 400, 'Enter the deal amount in ₹.');
    up.deal_value = deal; up.lost_reason = '';
    details = `Won · ${inr(deal)}`;
  } else {
    const reason = clean(b.lost_reason, 60);
    if (!LOST_REASONS.includes(reason)) return fail(res, 400, 'Choose why the lead was lost.');
    up.lost_reason = reason;
    details = `Lost · ${reason}`;
  }
  if (remark) { up.last_remark = remark; up.last_remark_at = t; details += ` — ${remark}`; }
  const keys = Object.keys(up);
  db.transaction(() => {
    db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => up[k]), lead.id);
    logActivity(lead.id, req.user.id, outcome, details);
  })();
  res.json({ lead: db.prepare(`${leadSelect} WHERE l.id = ?`).get(lead.id) });
});

app.delete('/api/leads/:id', auth, adminOnly, sameOrigin, (req, res) => {
  const r = db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  if (!r.changes) return fail(res, 404, 'Lead not found.');
  res.json({ ok: true });
});

app.post('/api/leads/:id/activities', auth, sameOrigin, (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return fail(res, 404, 'Lead not found.');
  const type = ACTIVITY_TYPES.includes(req.body.type) ? req.body.type : 'Note';
  const details = clean(req.body.details, 2000);
  if (!details) return fail(res, 400, 'Write something first.');
  logActivity(lead.id, req.user.id, type, details);
  db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run(now(), lead.id);
  res.status(201).json({ ok: true });
});

// ---------- export ----------
app.get('/api/export.csv', auth, adminOnly, (req, res) => {
  const rows = db.prepare(`${leadSelect} ORDER BY l.received_at DESC`).all();
  const cols = ['id', 'received_at', 'name', 'phone', 'business', 'need', 'start', 'priority', 'status', 'lost_reason',
    'deal_value', 'budget', 'decision_maker', 'follow_up', 'follow_time', 'call_attempts', 'last_outcome', 'last_remark', 'last_remark_at',
    'stage_at', 'assigned_name', 'notes', 'source', 'campaign', 'external_id'];
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="trata-leads-${now().slice(0, 10)}.csv"`);
  res.send('﻿' + csv);
});

// ---------- users (admin) ----------
app.get('/api/users', auth, adminOnly, (req, res) => {
  res.json({ users: db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY name').all() });
});

app.post('/api/users', auth, adminOnly, sameOrigin, (req, res) => {
  const username = clean(req.body.username, 30).toLowerCase();
  const name = clean(req.body.name, 80);
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  if (!name) return fail(res, 400, 'Enter the person’s name.');
  if (!validUsername(username)) return fail(res, 400, 'Login ID: 3–30 letters, numbers, dot, dash or underscore.');
  if (!validPassword(req.body.password)) return fail(res, 400, 'Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return fail(res, 400, 'That login ID is already taken.');
  db.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?,?)')
    .run(username, name, bcrypt.hashSync(req.body.password, 10), role);
  res.status(201).json({ ok: true });
});

app.patch('/api/users/:id', auth, adminOnly, sameOrigin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return fail(res, 404, 'User not found.');
  const b = req.body || {};
  const self = u.id === req.user.id;
  if ('name' in b) {
    if (!clean(b.name, 80)) return fail(res, 400, 'Name can’t be empty.');
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(clean(b.name, 80), u.id);
  }
  if ('role' in b) {
    if (self) return fail(res, 400, 'You can’t change your own role.');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role === 'admin' ? 'admin' : 'member', u.id);
  }
  if ('active' in b) {
    if (self) return fail(res, 400, 'You can’t deactivate yourself.');
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, u.id);
    if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  if ('password' in b) {
    if (!validPassword(b.password)) return fail(res, 400, 'Password must be at least 8 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.password, 10), u.id);
    if (!self) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  res.json({ ok: true });
});

// ---------- import (from Google Sheet / other sources) ----------
app.post('/api/import', (req, res) => {
  const key = req.get('X-Import-Key') || '';
  if (!IMPORT_KEY || key.length !== IMPORT_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(IMPORT_KEY))) {
    return fail(res, 401, 'Invalid import key.');
  }
  const list = Array.isArray(req.body && req.body.leads) ? req.body.leads.slice(0, 1000) : [];
  let added = 0;
  db.transaction(() => { for (const l of list) if (insertLead(l)) added++; })();
  res.json({ received: list.length, added, skipped: list.length - added });
});

// ---------- Meta Lead Ads webhook (real time) ----------
app.get('/api/meta/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && safeEqual(req.query['hub.verify_token'], db.getSetting('meta_verify_token'))) {
    return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
  }
  res.sendStatus(403);
});
app.post('/api/meta/webhook', (req, res) => {
  if (!meta.validSignature(req.rawBody, req.get('X-Hub-Signature-256'))) return res.sendStatus(403);
  meta.queueFromWebhook(req.body);
  res.sendStatus(200);
  meta.processPending().catch(() => {});
});

app.get('/api/admin/meta', auth, adminOnly, async (req, res) => {
  const st = meta.status();
  st.callbackUrl = `${req.protocol}://${req.get('host')}/api/meta/webhook`;
  st.subscribed = await meta.subscriptionStatus();
  res.json(st);
});
app.post('/api/admin/meta', auth, adminOnly, sameOrigin, async (req, res) => {
  const secret = clean(req.body.app_secret, 200);
  const token = clean(req.body.page_token, 1000);
  const pageId = clean(req.body.page_id, 40);
  if (secret) {
    if (!/^[a-f0-9]{32}$/i.test(secret)) return fail(res, 400, 'App Secret should be 32 letters/numbers. Copy it again from App settings → Basic.');
    db.setSetting('meta_app_secret', secret);
  }
  if (token) {
    try { await meta.connectPage(token, pageId || undefined); } catch (e) { return fail(res, 400, 'Meta did not accept the token: ' + e.message); }
  }
  res.json(meta.status());
});
app.post('/api/admin/meta/sync', auth, adminOnly, sameOrigin, async (req, res) => {
  try {
    await meta.processPending();
    const r = await meta.pollRecent(Math.min(24 * 90, Math.max(1, Number(req.body.hours) || 72)));
    res.json(r);
  } catch (e) { fail(res, 400, 'Meta: ' + e.message); }
});

// ---------- static app ----------
// The page itself is never cached, so a new version reaches everyone at once; its css/js carry a ?v= tag.
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h',
  setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.use('/api', (req, res) => fail(res, 404, 'Not found.'));
app.get('/{*splat}', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'Bad request.');
  fail(res, 500, 'Something went wrong on the server.');
});

if (require.main === module) {
  if (!IMPORT_KEY) console.warn('IMPORT_KEY is not set – the Google Sheet import is disabled.');
  meta.start();
  app.listen(PORT, '127.0.0.1', () => console.log(`TRATA CRM running on http://127.0.0.1:${PORT}`));
}
module.exports = app;
