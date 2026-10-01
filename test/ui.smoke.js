'use strict';
// Browser walkthrough of every screen. Needs a running server with demo data.
// Usage: BASE=http://127.0.0.1:3111 LOGIN=aniket PASS=... SHOTS=/tmp/shots node test/ui.smoke.js
const { chromium } = require('playwright');
const assert = require('assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const SHOTS = process.env.SHOTS || '.';
const errors = [];

(async () => {
  const browser = await chromium.launch();
  for (const vp of [{ name: 'desktop', width: 1366, height: 860 }, { name: 'phone', width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`[${vp.name}] console: ${m.text()}`); });
    page.on('response', (r) => { const u = r.url(); if (u.startsWith(BASE) && r.status() >= 500) errors.push(`[${vp.name}] ${r.status()} ${u}`); });
    page.on('pageerror', (e) => errors.push(`[${vp.name}] pageerror: ${e.message}`));
    const shot = (n) => page.screenshot({ path: `${SHOTS}/${vp.name}-${n}.png`, fullPage: false });
    const step = (m) => console.log(`[${vp.name}] ${m}`);

    await page.goto(BASE);
    if (vp.name === 'desktop') {
      // Fresh install: setup screen, not login
      await page.waitForSelector('#setup:not([hidden])');
      await shot('00-setup');
      await page.fill('#s-code', 'WRONG-CODE'); await page.fill('#s-name', 'Aniket'); await page.fill('#s-id', process.env.LOGIN);
      await page.fill('#s-pw', process.env.PASS); await page.fill('#s-pw2', process.env.PASS);
      await page.click('#setupBtn');
      await page.waitForFunction(() => document.querySelector('#setupErr').textContent.includes('Setup code is wrong'));
      await page.fill('#s-code', process.env.SETUP_CODE);
      await page.fill('#s-pw2', 'different-pass');
      await page.click('#setupBtn');
      await page.waitForFunction(() => document.querySelector('#setupErr').textContent.includes('not the same'));
      await page.fill('#s-pw2', process.env.PASS);
      await page.click('#setupBtn');
      await page.waitForSelector('#app:not([hidden])');
      step('setup screen: wrong code and mismatched passwords caught, admin created and logged in');
      await page.click('#userBtn'); await page.click('#logoutBtn');
    }
    await page.waitForSelector('#gate:not([hidden])');
    await shot('01-login');
    step('login screen shown');

    await page.fill('#g-id', process.env.LOGIN);
    await page.fill('#g-pw', 'wrong-password');
    await page.click('#loginBtn');
    await page.waitForFunction(() => document.querySelector('#loginErr').textContent.length > 0);
    assert.match(await page.textContent('#loginErr'), /Wrong login ID/);
    step('wrong password rejected');

    await page.fill('#g-pw', process.env.PASS);
    await page.click('#loginBtn');
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForSelector('#kpis .kpi');
    assert.equal(await page.locator('#todo .todo-row').count() >= 1, true);
    await shot('02-dashboard');
    step('dashboard loaded: ' + (await page.locator('#kpis .kpi').count()) + ' tiles, ' + (await page.locator('#todo .todo-row').count()) + ' to-do rows');

    // Leads list + search
    await page.click('.tab[data-view="list"]');
    const total = await page.locator('#rows tr[data-id]').count();
    await page.fill('#q', 'ravi');
    assert.equal(await page.locator('#rows tr[data-id]').count(), 1);
    await page.fill('#q', '');
    await shot('03-leads');
    step(`leads list: ${total} rows, search works`);

    // Open lead, log a call, then edit follow-up/assignee/notes
    await page.click('#rows tr[data-id] >> text=Asha');
    await page.waitForSelector('#callSteps .opt');
    await page.click('#callSteps .opt[data-v="connected"]');
    await page.click('#callSteps .opt[data-v="interested"]');
    await page.click('#callSteps .opt[data-v="Warm"]');
    await page.click('#callSteps [data-day="3"]');
    await page.fill('#c-remark', 'Wants 5-page site. Send quote.');
    await page.click('#cSave');
    await page.waitForFunction(() => document.querySelector('#drawer .timeline') && document.querySelector('#drawer .timeline').textContent.includes('Interested · Warm'));
    await page.click('#drawer details.more summary');
    await page.fill('#d-follow', '2026-09-27');
    await page.selectOption('#d-assigned', { label: 'Aniket' });
    await page.fill('#d-notes', 'Prefers WhatsApp.');
    await page.click('#dSave');
    await page.waitForFunction(() => document.querySelector('#drawer .timeline').textContent.includes('Assigned'));
    await page.fill('#d-log', 'Sent WhatsApp with portfolio');
    await page.selectOption('#d-type', 'WhatsApp');
    await page.click('#dLog');
    await page.waitForFunction(() => document.querySelector('#drawer .timeline').textContent.includes('Sent WhatsApp with portfolio'));
    const wa = await page.getAttribute('#drawer a.btn.primary', 'href');
    assert.equal(wa, 'https://wa.me/919800000001');
    await shot('04-lead-drawer');
    step('lead drawer: logged a call (connected, interested, warm), saved follow-up/assignee/notes, WhatsApp link ok');
    await page.click('#dClose');

    // Pipeline board
    await page.click('.tab[data-view="board"]');
    await page.waitForSelector('#board .col');
    const interestedCol = page.locator('#board .col', { hasText: 'Interested' }).first();
    assert.ok((await interestedCol.textContent()).includes('Asha'));
    await shot('05-pipeline');
    step('pipeline shows lead under Interested');

    // Add lead
    await page.click('#addBtn');
    await page.fill('#a-name', `UI Test ${vp.name}`);
    await page.fill('#a-phone', '9876500000');
    await page.selectOption('#a-need', 'Mobile app');
    await shot('06-add-lead');
    await page.click('#addSave');
    await page.waitForSelector('#addModal', { state: 'hidden' });
    await page.click('.tab[data-view="list"]');
    await page.fill('#q', `UI Test ${vp.name}`);
    assert.equal(await page.locator('#rows tr[data-id]').count(), 1);
    await page.fill('#q', '');
    step('manual lead added');

    // KPI tile filter
    await page.click('.tab[data-view="dash"]');
    await page.click('#kpis [data-go="due"]');
    await page.waitForSelector('#v-list:not([hidden])');
    const dueRows = await page.locator('#rows tr[data-id]').count();
    assert.ok(dueRows >= 1, 'follow-up due today should show');
    step(`"Follow-ups due" tile filters list (${dueRows})`);
    await page.selectOption('#fDue', '');

    // Team (admin)
    await page.click('.tab[data-view="team"]');
    await page.waitForSelector('#userList .urow');
    const uname = `member${vp.name}`;
    await page.fill('#u-name', `Member ${vp.name}`);
    await page.fill('#u-id', uname);
    await page.fill('#u-pw', 'member-pass-1');
    await page.click('#userSave');
    await page.waitForFunction((n) => document.querySelector('#userList').textContent.includes(n), uname);
    await page.waitForFunction(() => document.querySelector('#m-vt').textContent.length > 20);
    assert.match(await page.textContent('#metaStatus'), /Not connected yet/);
    assert.match(await page.textContent('#m-cb'), /\/api\/meta\/webhook$/);
    await page.fill('#m-secret', 'not-a-secret'); await page.click('#metaSave');
    await page.waitForFunction(() => document.querySelector('#metaErr').textContent.includes('App Secret'));
    await page.fill('#m-secret', '');
    await page.locator('#metaCard').scrollIntoViewIfNeeded();
    await shot('07-team');
    step('team member added; Meta panel shows callback URL, verify token, status, validates input');

    // Live: a lead arrives while the page is open -> appears without refresh + toast
    await page.click('.tab[data-view="dash"]');
    const liveName = `Live Lead ${vp.name}`;
    await fetch(BASE + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Import-Key': process.env.IMPORT_KEY },
      body: JSON.stringify({ leads: [{ lead_id: 'LIVE-' + vp.name, created_time: new Date().toISOString(), name: liveName, phone: '9800099999', need: 'new_website', start: 'immediately' }] }) });
    const t0 = Date.now();
    await page.waitForFunction((n) => document.querySelector('#toast').textContent.includes(n), liveName, { timeout: 20000 });
    assert.ok((await page.textContent('#todo')).includes(liveName));
    await shot('07b-live-lead');
    step(`live: new lead appeared on screen ${Math.round((Date.now() - t0) / 1000)} s after arriving, with a toast`);

    // Change own password modal opens and validates
    await page.click('#userBtn');
    await page.click('#pwBtn');
    await page.fill('#pw-old', 'nope-nope');
    await page.fill('#pw-new', 'something-new-1');
    await page.click('#pwSave');
    await page.waitForFunction(() => document.querySelector('#pwErr').textContent.length > 0);
    await shot('08-password');
    await page.keyboard.press('Escape');
    step('change-password shows error for wrong current password');

    // Log out, log in as member: no Team tab, no delete
    await page.click('#userBtn');
    await page.click('#logoutBtn');
    await page.waitForSelector('#gate:not([hidden])');
    await page.fill('#g-id', uname);
    await page.fill('#g-pw', 'member-pass-1');
    await page.click('#loginBtn');
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForSelector('#kpis .kpi');
    assert.equal(await page.isHidden('#teamTab'), true);
    await page.click('.tab[data-view="list"]');
    await page.click('#rows tr[data-id] >> text=Ravi');
    await page.waitForSelector('#dForm');
    assert.equal(await page.locator('#dDelete').count(), 0);
    await shot('09-member-view');
    step('member login: no Team tab, no delete button');

    // Session persists on reload
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    step('stays logged in after reload');
    await ctx.close();
  }
  await browser.close();
  if (errors.length) { console.log('\nBROWSER ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nALL UI CHECKS PASSED');
})().catch((e) => { console.error('FAILED:', e.message); console.log(errors.join('\n')); process.exit(1); });
