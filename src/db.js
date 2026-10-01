'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'crm.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id  TEXT UNIQUE,
  received_at  TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  business     TEXT NOT NULL DEFAULT '',
  need         TEXT NOT NULL DEFAULT '',
  start        TEXT NOT NULL DEFAULT '',
  priority     TEXT NOT NULL DEFAULT 'Cold',
  status       TEXT NOT NULL DEFAULT 'New',
  follow_up    TEXT,
  assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes        TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT '',
  campaign     TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_status   ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_received ON leads(received_at);

CREATE TABLE IF NOT EXISTS activities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type       TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_act_lead ON activities(lead_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Meta "leadgen" webhook notifications waiting to be turned into leads (retried on failure)
CREATE TABLE IF NOT EXISTS meta_events (
  leadgen_id  TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

// ---------- v2: call-by-call stage flow ----------
// New columns for the "log a call" flow. Added in place so existing data is kept.
const leadCols = new Set(db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name));
const addCol = (name, def) => { if (!leadCols.has(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${def}`); };
addCol('call_attempts', 'INTEGER NOT NULL DEFAULT 0');   // calls in a row that did not connect
addCol('last_call', "TEXT NOT NULL DEFAULT ''");         // 'connected' | 'not_connected' | ''
addCol('last_call_at', 'TEXT');
addCol('ever_connected', 'INTEGER NOT NULL DEFAULT 0');
addCol('last_remark', "TEXT NOT NULL DEFAULT ''");
addCol('last_remark_at', 'TEXT');

// One-time move of the old statuses into the new stages.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'stage_flow_v2'").get()) {
  db.transaction(() => {
    db.exec(`
      UPDATE leads SET status = 'Fresh' WHERE status = 'New';
      UPDATE leads SET status = 'Interested', ever_connected = 1, last_call = 'connected'
        WHERE status IN ('Contacted', 'Follow-up', 'Quote sent', 'Interested');
      UPDATE leads SET ever_connected = 1, last_call = 'connected' WHERE status IN ('Won', 'Lost');
      UPDATE leads SET last_remark = notes, last_remark_at = updated_at WHERE notes != '' AND last_remark = '';
    `);
    db.prepare("INSERT INTO settings (key, value) VALUES ('stage_flow_v2', ?)").run(new Date().toISOString());
  })();
}
// ---------- v3: sales pipeline stages ----------
// Stage = where the deal is; call results are logged on the lead, not used as stages.
addCol('stage_at', 'TEXT');                               // when the lead entered its current stage
addCol('cut_count', 'INTEGER NOT NULL DEFAULT 0');       // times they cut the call / were busy
addCol('lost_reason', "TEXT NOT NULL DEFAULT ''");
addCol('deal_value', 'INTEGER');                          // ₹, set at quote / won
addCol('budget', "TEXT NOT NULL DEFAULT ''");
addCol('decision_maker', "TEXT NOT NULL DEFAULT ''");    // 'yes' | 'no' | ''
addCol('follow_time', "TEXT NOT NULL DEFAULT ''");       // 'HH:MM', e.g. a meeting time
addCol('last_outcome', "TEXT NOT NULL DEFAULT ''");      // last call button pressed

if (!db.prepare("SELECT 1 FROM settings WHERE key = 'stage_flow_v3'").get()) {
  db.transaction(() => {
    db.exec(`
      UPDATE leads SET status = 'New' WHERE status = 'Fresh';
      UPDATE leads SET status = 'Trying to reach' WHERE status = 'Not connected';
      UPDATE leads SET status = 'Qualifying' WHERE status = 'Interested';
      UPDATE leads SET status = 'Lost', lost_reason = 'Not interested', follow_up = NULL WHERE status = 'Not interested';
      UPDATE leads SET stage_at = updated_at WHERE stage_at IS NULL;
      -- Every open lead needs a next date: undated ones show up in today's list to be sorted into the right stage.
      UPDATE leads SET follow_up = date('now', '+330 minutes')
        WHERE follow_up IS NULL AND status IN ('Trying to reach', 'Qualifying');
    `);
    db.prepare("INSERT INTO settings (key, value) VALUES ('stage_flow_v3', ?)").run(new Date().toISOString());
  })();
}
// Leads written with an older default (e.g. by an older import) are always New.
db.exec("UPDATE leads SET status = 'New' WHERE status = 'Fresh'");
db.exec('UPDATE leads SET stage_at = created_at WHERE stage_at IS NULL');

const getSetting = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : ''; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v ?? ''));

module.exports = db;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
