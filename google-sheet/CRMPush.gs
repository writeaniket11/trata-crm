/**
 * TRATA Digital – send leads from this Google Sheet to the CRM
 * -------------------------------------------------------------
 * Add this file to the sheet's Apps Script project (Extensions → Apps Script → + → Script,
 * name it "CRMPush"). Then reload the sheet and use the menu:
 *     TRATA Leads → Connect to CRM…
 * You will be asked for the CRM address and the import key (from the server's .env file).
 *
 * After that, every 5 minutes the script sends leads from the last 7 days to the CRM.
 * The CRM ignores leads it already has, so nothing is ever duplicated, and sorting or
 * filtering the sheet can't make it miss a lead.
 */

const CRM_WINDOW_DAYS = 7;     // how far back each automatic push looks
const CRM_BATCH = 500;         // leads per request

function connectCrm() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const urlAns = ui.prompt('Connect to CRM (1 of 2)',
    'CRM address, for example: https://crm.tratadigital.com', ui.ButtonSet.OK_CANCEL);
  if (urlAns.getSelectedButton() !== ui.Button.OK) return;
  const url = urlAns.getResponseText().trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+$/.test(url)) { ui.alert('Please enter the address starting with https:// (nothing after the domain).'); return; }

  const keyAns = ui.prompt('Connect to CRM (2 of 2)',
    'Import key (IMPORT_KEY from the server\'s .env file):', ui.ButtonSet.OK_CANCEL);
  if (keyAns.getSelectedButton() !== ui.Button.OK) return;
  const key = keyAns.getResponseText().trim();
  if (key.length < 20) { ui.alert('That key looks too short. Copy the full IMPORT_KEY value.'); return; }

  props.setProperties({ CRM_URL: url, CRM_KEY: key });

  // Test the connection and send every lead already in the sheet.
  let result;
  try { result = pushLeads_(null); } catch (e) { ui.alert('Could not reach the CRM:\n\n' + e.message); return; }

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'pushToCrm')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pushToCrm').timeBased().everyMinutes(5).create();

  ui.alert('Connected to the CRM.\n\n' + result.added + ' lead(s) added, ' + result.skipped +
    ' already there.\nNew leads will be sent automatically every 5 minutes.');
}

/** Runs every 5 minutes: sends leads received in the last few days. */
function pushToCrm() {
  const since = new Date(Date.now() - CRM_WINDOW_DAYS * 864e5);
  return pushLeads_(since);
}

/** Menu item: send every lead in the sheet again (safe – duplicates are skipped). */
function pushAllToCrm() {
  const r = pushLeads_(null);
  SpreadsheetApp.getActive().toast(r.added + ' added, ' + r.skipped + ' already in the CRM.', 'TRATA CRM', 8);
  return r;
}

function pushLeads_(since) {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('CRM_URL');
  const key = props.getProperty('CRM_KEY');
  if (!url || !key) throw new Error('CRM is not connected yet. Use TRATA Leads → Connect to CRM…');

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const last = sh.getLastRow();
  const total = { received: 0, added: 0, skipped: 0 };
  if (last < 2) return total;

  // Columns A–N: Lead ID, Received, Name, Phone, WhatsApp, Business, Needs, Start, Priority, Status, Follow-up, Notes, Assigned, Campaign
  const rows = sh.getRange(2, 1, last - 1, 14).getValues();
  const leads = [];
  rows.forEach(r => {
    const id = String(r[0] || '').trim();
    if (!id) return;
    const received = r[1] instanceof Date ? r[1] : new Date(r[1]);
    if (since && !(received >= since)) return;
    leads.push({
      lead_id: id,
      created_time: isNaN(received) ? '' : received.toISOString(),
      name: String(r[2] || ''),
      phone: String(r[3] || ''),
      business: String(r[5] || ''),
      need: String(r[6] || ''),
      start: String(r[7] || ''),
      campaign: String(r[13] || ''),
      source: 'Instant Form'
    });
  });

  for (let i = 0; i < leads.length; i += CRM_BATCH) {
    const res = UrlFetchApp.fetch(url + '/api/import', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Import-Key': key },
      payload: JSON.stringify({ leads: leads.slice(i, i + CRM_BATCH) }),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code !== 200) {
      let msg = res.getContentText().slice(0, 300);
      if (code === 401) msg = 'The import key is wrong. Run "Connect to CRM…" again with the key from the server.';
      throw new Error('CRM replied ' + code + ': ' + msg);
    }
    const r = JSON.parse(res.getContentText());
    total.received += r.received; total.added += r.added; total.skipped += r.skipped;
  }
  return total;
}
