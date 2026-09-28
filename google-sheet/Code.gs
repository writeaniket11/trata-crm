/**
 * TRATA Digital – Lead Tracker (free, automatic)
 * ----------------------------------------------
 * How it works:
 *   • Claude runs a cloud task every hour that saves new Meta Instant Form
 *     leads as a small CSV file in the Drive folder "TRATA Leads Inbox".
 *   • This script checks that folder every 5 minutes, adds any new leads to
 *     the "Leads" tab (no duplicates) and then moves the CSV to the trash.
 *   • Status, Follow-up date, Notes and Assigned to are for your team.
 *     The script never overwrites them.
 * One-time: run "setup" and click Allow.
 */

// ---------- Settings you can change ----------
const INBOX_FOLDER_ID = '1kdx-6JbPCXzi4uBlCHOVtRuZPCMDPpOD'; // Drive folder Claude writes to
const SHEET_NAME    = 'Leads';
const TIMEZONE      = 'Asia/Kolkata';
const SYNC_EVERY_MIN = 5;             // allowed: 1, 5, 10, 15, 30
const STATUSES = ['New', 'Contacted', 'Follow-up', 'Interested', 'Quote sent', 'Won', 'Lost'];

// Column layout (A..P). Columns J–M are for your team and are never overwritten.
const HEADERS = [
  'Lead ID',        // A
  'Received (IST)', // B
  'Name',           // C
  'Phone',          // D
  'WhatsApp',       // E
  'Business type',  // F
  'Needs',          // G
  'Wants to start', // H
  'Priority',       // I
  'Status',         // J  (team edits)
  'Follow-up date', // K  (team edits)
  'Notes',          // L  (team edits)
  'Assigned to',    // M  (team edits)
  'Campaign',       // N
  'Ad',             // O
  'Form'            // P
];

// ---------- Menu ----------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('TRATA Leads')
    .addItem('Sync new leads now', 'syncLeads')
    .addItem('Run setup again', 'setup')
    .addSeparator()
    .addItem('Connect to CRM…', 'connectCrm')
    .addItem('Send all leads to CRM now', 'pushAllToCrm')
    .addToUi();
}

// ---------- One-time setup ----------
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TIMEZONE);
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.getSheets()[0];
    sh.setName(SHEET_NAME);
  }

  // Headers
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#0f6e5a').setFontColor('#ffffff')
    .setVerticalAlignment('middle');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(3);
  sh.setRowHeight(1, 32);

  // Column widths
  const widths = [140, 140, 170, 130, 110, 170, 190, 130, 90, 120, 120, 280, 120, 260, 200, 220];
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.getRange('L:L').setWrap(true);
  sh.getRange('A:A').setNumberFormat('@');   // keep long IDs as text
  sh.getRange('D:D').setNumberFormat('@');   // keep phone numbers as text
  sh.getRange('B:B').setNumberFormat('dd mmm yyyy, h:mm am/pm');
  sh.getRange('K:K').setNumberFormat('dd mmm yyyy');

  // Status dropdown + date picker on data rows
  const maxRows = Math.max(sh.getMaxRows(), 2000);
  if (sh.getMaxRows() < maxRows) sh.insertRowsAfter(sh.getMaxRows(), maxRows - sh.getMaxRows());
  sh.getRange(2, 10, maxRows - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build());
  sh.getRange(2, 11, maxRows - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());

  // Colour rules
  const all = sh.getRange(2, 1, maxRows - 1, HEADERS.length);
  const pr  = sh.getRange(2, 9, maxRows - 1, 1);
  const st  = sh.getRange(2, 10, maxRows - 1, 1);
  const fu  = sh.getRange(2, 11, maxRows - 1, 1);
  const rules = [
    // Whole row: Won = green, Lost = grey
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$J2="Won"')
      .setBackground('#dcfce7').setRanges([all]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$J2="Lost"')
      .setBackground('#eeeeee').setFontColor('#888888').setRanges([all]).build(),
    // Priority chips
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Hot')
      .setBackground('#fdeadf').setFontColor('#c2410c').setBold(true).setRanges([pr]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Warm')
      .setBackground('#fbf1d6').setFontColor('#a16207').setBold(true).setRanges([pr]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Cold')
      .setBackground('#e8ecef').setFontColor('#51606b').setRanges([pr]).build(),
    // Status "New" highlighted so nobody misses it
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('New')
      .setBackground('#dbeafe').setFontColor('#1d4ed8').setBold(true).setRanges([st]).build(),
    // Follow-up date today or overdue (and not closed) = red
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($K2<>"",$K2<=TODAY(),$J2<>"Won",$J2<>"Lost")')
      .setBackground('#fee2e2').setFontColor('#b91c1c').setBold(true).setRanges([fu]).build()
  ];
  sh.setConditionalFormatRules(rules);

  // Filter for easy sorting
  if (!sh.getFilter()) sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).createFilter();

  // Automatic sync trigger (replace any old one)
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncLeads')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncLeads').timeBased().everyMinutes(SYNC_EVERY_MIN).create();

  // First sync right now
  const added = syncLeads();
  SpreadsheetApp.getActive().toast(
    'Setup done. ' + added + ' lead(s) added. New leads will arrive every ' + SYNC_EVERY_MIN + ' minutes.',
    'TRATA Leads', 10);
}

// ---------- Sync ----------
function syncLeads() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return 0;
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const last = sh.getLastRow();
    const known = new Set(
      last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : []);

    const folder = DriveApp.getFolderById(INBOX_FOLDER_ID);
    const files = folder.getFiles();
    const fresh = [];
    const done = [];
    while (files.hasNext()) {
      const file = files.next();
      if (!/\.csv$/i.test(file.getName())) continue;
      const rows = Utilities.parseCsv(file.getBlob().getDataAsString('UTF-8'));
      const head = rows.shift() || [];
      const col = n => head.indexOf(n);
      rows.forEach(r => {
        const id = String(r[col('lead_id')] || '').trim();
        if (!id || known.has(id)) return;
        known.add(id);
        fresh.push(toRow_({
          id: id,
          created_time: r[col('created_time')],
          campaign_name: r[col('campaign')],
          name: r[col('name')],
          phone: r[col('phone')],
          business: r[col('business')],
          need: r[col('need')],
          start: r[col('start')]
        }));
      });
      done.push(file);
    }

    if (fresh.length) {
      fresh.sort((a, b) => a[1] - b[1]); // oldest first, newest at the bottom
      sh.getRange(sh.getLastRow() + 1, 1, fresh.length, HEADERS.length).setValues(fresh);
    }
    done.forEach(f => f.setTrashed(true));
    return fresh.length;
  } finally {
    lock.releaseLock();
  }
}

// ---------- Helpers ----------
function toRow_(l) {
  const start    = String(l.start || '');
  const priority = start === 'immediately' ? 'Hot' : start === 'within_1_month' ? 'Warm' : 'Cold';
  let digits = String(l.phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  const wa = digits ? '=HYPERLINK("https://wa.me/' + digits + '","Open chat")' : '';
  return [
    l.id,
    new Date(String(l.created_time).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')),
    l.name || '',
    String(l.phone || ''),
    wa,
    human_(l.business),
    human_(l.need),
    human_(start),
    priority,
    'New', '', '', '',
    l.campaign_name || '',
    '',
    'Instant Form'
  ];
}

function pick_(f, keys) {
  for (const k of keys) if (f[k]) return f[k];
  return '';
}

function human_(v) {
  if (!v) return '';
  const map = {
    new_website: 'New website', website_redesign: 'Website redesign', mobile_app: 'Mobile app',
    'whatsapp_automation_/_bulk_sms': 'WhatsApp automation / Bulk SMS', 'branding_/_logo': 'Branding / Logo',
    'seo_/_digital_marketing': 'SEO / Digital marketing', immediately: 'Immediately',
    within_1_month: 'Within 1 month', just_exploring: 'Just exploring', other_business: 'Other business'
  };
  if (map[v]) return map[v];
  const s = String(v).replace(/_/g, ' ').replace(/\s+\/\s+/g, ' / ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
