'use strict';
// Runs google-sheet/Code.gs + CRMPush.gs against a live CRM with mocked Google services.
// Usage: CRM=http://127.0.0.1:3111 KEY=... node test/sheet-push.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const assert = require('assert/strict');

const CRM = process.env.CRM, KEY = process.env.KEY;
const day = 864e5;
const sheetRows = [
  ['HDR'],
  ['S1', new Date(Date.now() - 1 * day), 'Sheet One', '+919811111111', '', 'Other business', 'New website', 'Immediately', 'Hot', 'New', '', '', '', 'Reel campaign'],
  ['S2', new Date(Date.now() - 2 * day), 'Sheet Two', '9822222222', '', 'Clinic', 'Branding / Logo', 'Within 1 month', 'Warm', 'New', '', '', '', 'Reel campaign'],
  ['S3', new Date(Date.now() - 30 * day), 'Old Lead', '9833333333', '', 'Shop', 'Mobile app', 'Just exploring', 'Cold', 'New', '', '', '', 'Reel campaign'],
];
const props = {};
const prompts = [];
const alerts = [];
const triggers = [];

// Synchronous HTTP (UrlFetchApp is synchronous) via a child curl process.
function fetchSync(url, o) {
  url = url.replace('https://crm.test', CRM); // Apps Script needs https; route the test address to the local server
  const out = execFileSync('curl', ['-s', '-w', '\n%{http_code}', '-X', 'POST', url,
    '-H', 'Content-Type: ' + o.contentType, '-H', 'X-Import-Key: ' + o.headers['X-Import-Key'], '--data-binary', '@-'],
  { input: o.payload }).toString();
  const i = out.lastIndexOf('\n');
  return { getResponseCode: () => Number(out.slice(i + 1)), getContentText: () => out.slice(0, i) };
}

const sheet = {
  getLastRow: () => sheetRows.length,
  getRange: (r, c, nr, nc) => ({ getValues: () => sheetRows.slice(r - 1, r - 1 + nr).map((row) => { const x = row.slice(c - 1, c - 1 + nc); while (x.length < nc) x.push(''); return x; }) }),
};
const ctx = {
  console, JSON, Date, Math, String, Number, Error, isNaN, Set,
  SpreadsheetApp: {
    getUi: () => ({ ButtonSet: { OK_CANCEL: 1 }, Button: { OK: 'OK' },
      prompt: () => { const v = prompts.shift(); return { getSelectedButton: () => 'OK', getResponseText: () => v }; },
      alert: (m) => alerts.push(m) }),
    getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }),
    getActive: () => ({ toast: (m) => alerts.push('toast: ' + m) }),
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperties: (o) => Object.assign(props, o) }) },
  ScriptApp: { getProjectTriggers: () => triggers.slice(), deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
    newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => triggers.push({ getHandlerFunction: () => fn, n }) }) }) }) },
  UrlFetchApp: { fetch: fetchSync },
};
vm.createContext(ctx);
const dir = path.join(__dirname, '..', 'google-sheet');
vm.runInContext(fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8') + '\n' + fs.readFileSync(path.join(dir, 'CRMPush.gs'), 'utf8'), ctx);

// 1. wrong key -> clear error, no trigger
prompts.push('https://crm.test', 'x'.repeat(30));
ctx.connectCrm();
assert.match(alerts.pop(), /import key is wrong/);
assert.equal(triggers.length, 0);
console.log('wrong key: clear error, nothing scheduled');

// 2. correct key -> all 3 sent, trigger installed
prompts.push('https://crm.test/', KEY);
ctx.connectCrm();
const msg = alerts.pop();
assert.match(msg, /3 lead\(s\) added, 0 already there/);
assert.equal(triggers.length, 1);
assert.equal(triggers[0].getHandlerFunction(), 'pushToCrm');
console.log('connect: 3 leads backfilled, 5-minute trigger installed');

// 3. automatic push only looks at last 7 days, and dedupes
sheetRows.push(['S4', new Date(), 'Brand New', '9844444444', '', 'Gym', 'SEO / Digital marketing', 'Immediately', 'Hot', 'New', '', '', '', 'Reel campaign']);
const r = ctx.pushToCrm();
assert.deepEqual({ ...r }, { received: 3, added: 1, skipped: 2 });
console.log('auto push: 3 recent rows checked, 1 new added, 2 skipped');

// 4. running connect again doesn't stack triggers
prompts.push('https://crm.test', KEY);
ctx.connectCrm();
assert.equal(triggers.length, 1);
console.log('reconnect: still exactly one trigger');
console.log('\nSHEET PUSH CHECKS PASSED');
