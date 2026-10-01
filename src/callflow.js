'use strict';
/**
 * What happens to a lead after one call. Pure function: takes the lead and the call, returns the changes.
 *
 * Didn't talk:  no_answer · switched_off · busy (cut the call) · wrong_number
 * Talked:       interested · not_now · not_interested
 */
const { TEMPERATURES, LOST_REASONS, BUDGETS, MAX_TRIES, MAX_CUTS, FINAL_TRY_DAYS } = require('./labels');

const NOT_CONNECTED = ['no_answer', 'switched_off', 'busy'];
const OUTCOMES = [...NOT_CONNECTED, 'wrong_number', 'interested', 'not_now', 'not_interested'];
const NEXT_STEPS = ['callback', 'meeting', 'quote', 'negotiation'];
const LABEL = {
  no_answer: 'No answer', switched_off: 'Switched off', busy: 'Cut the call / Busy', wrong_number: 'Wrong number',
  interested: 'Interested', not_now: 'Not now', not_interested: 'Not interested',
};
const EARLY = ['New', 'Trying to reach'];
const STAGE_FOR_NEXT = { meeting: 'Meeting booked', quote: 'Quote sent', negotiation: 'Negotiation' };
const ORDER = ['New', 'Trying to reach', 'Qualifying', 'Meeting booked', 'Quote sent', 'Negotiation'];

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
function addDays(day, n) { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function rupees(v) { const n = Math.round(Number(String(v ?? '').replace(/[^\d.]/g, ''))); return n > 0 && n < 1e10 ? n : null; }
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');

/** When to try again after a call that did not connect (if the caller didn't pick a date). */
function nextTry(outcome, today, hour) {
  if (outcome === 'no_answer') return hour < 17 ? today : addDays(today, 1); // later today, at a different time
  if (outcome === 'switched_off') return addDays(today, 1);                   // phone dead / travelling
  return addDays(today, 2);                                                    // busy: give them space
}

/**
 * @param lead  current row
 * @param b     { outcome, follow_up, follow_time, temperature, next, need, budget, decision_maker, deal_value, lost_reason }
 * @param ctx   { today: 'YYYY-MM-DD' (IST), hour: 0-23 (IST) }
 * @returns { error } or { up: {column: value}, log: 'text for history', auto: 'text shown to the caller' | '' }
 */
function applyCall(lead, b, ctx) {
  const o = b.outcome;
  if (!OUTCOMES.includes(o)) return { error: 'Choose what happened on the call.' };
  if (lead.status === 'Won') return { error: 'This deal is already won. Add a note in History instead.' };
  const follow = b.follow_up ? String(b.follow_up) : null;
  if (follow && !isDate(follow)) return { error: 'Follow-up date is not valid.' };
  const time = b.follow_time ? String(b.follow_time) : '';
  if (time && !isTime(time)) return { error: 'Time is not valid.' };
  if (follow && follow < ctx.today) return { error: 'Follow-up date is in the past.' };

  const up = { last_outcome: o };
  const log = [LABEL[o]];
  let auto = '';
  const setStage = (s) => { if (s !== lead.status) { up.status = s; up.stage_at = true; } };

  if (NOT_CONNECTED.includes(o)) {
    up.last_call = 'not_connected';
    up.call_attempts = lead.call_attempts + 1;
    up.cut_count = lead.cut_count + (o === 'busy' ? 1 : 0);
    log[0] += ` (try ${up.call_attempts})`;
    if (lead.status === 'Lost') {
      // The one final try for an Unreachable lead also failed: it stays lost.
      up.follow_up = null; up.follow_time = '';
      auto = 'Final try did not connect. The lead stays Lost.';
    } else if (EARLY.includes(lead.status) && up.cut_count >= MAX_CUTS) {
      setStage('Lost'); up.lost_reason = 'Not responding'; up.follow_up = null; up.follow_time = '';
      auto = `Cut the call ${up.cut_count} times → moved to Lost (Not responding).`;
    } else if (EARLY.includes(lead.status) && up.call_attempts >= MAX_TRIES) {
      setStage('Lost'); up.lost_reason = 'Unreachable'; up.follow_up = addDays(ctx.today, FINAL_TRY_DAYS); up.follow_time = '';
      auto = `${up.call_attempts} tries with no answer → moved to Lost (Unreachable). It comes back once on ${up.follow_up} for a final try.`;
    } else {
      // A missed call never moves a lead backwards: someone in Quote sent stays in Quote sent.
      if (lead.status === 'New') setStage('Trying to reach');
      up.follow_up = follow || nextTry(o, ctx.today, ctx.hour);
      up.follow_time = time;
      log.push(`next try ${up.follow_up}`);
    }
  } else if (o === 'wrong_number') {
    up.last_call = 'not_connected';
    setStage('Lost'); up.lost_reason = 'Wrong number / Junk'; up.follow_up = null; up.follow_time = '';
  } else {
    // ----- talked -----
    up.last_call = 'connected'; up.call_attempts = 0; up.cut_count = 0; up.ever_connected = 1;
    if (o === 'interested') {
      if (!TEMPERATURES.includes(b.temperature)) return { error: 'Choose Hot, Warm or Cold.' };
      if (!NEXT_STEPS.includes(b.next)) return { error: 'Choose the next step.' };
      if (!follow) return { error: b.next === 'meeting' ? 'Pick the meeting date.' : 'Pick the next follow-up date.' };
      const budget = b.budget ? String(b.budget) : '';
      if (budget && !BUDGETS.includes(budget)) return { error: 'Unknown budget.' };
      const dm = b.decision_maker ? String(b.decision_maker) : '';
      if (dm && !['yes', 'no'].includes(dm)) return { error: 'Decision maker should be yes or no.' };
      let deal = null;
      if (b.deal_value !== undefined && b.deal_value !== null && b.deal_value !== '') {
        deal = rupees(b.deal_value);
        if (deal === null) return { error: 'Quote amount should be in ₹.' };
      }
      up.priority = b.temperature;
      if (budget) up.budget = budget;
      if (dm) up.decision_maker = dm;
      if (b.need) up.need = String(b.need).trim().slice(0, 120);
      if (deal) up.deal_value = deal;
      up.follow_up = follow; up.follow_time = time;
      if (b.next === 'callback') {
        // Stay where they are, but anyone not yet qualified is now Qualifying.
        if (ORDER.indexOf(lead.status) < 2) setStage('Qualifying');
      } else {
        setStage(STAGE_FOR_NEXT[b.next]);
      }
      log.push(b.temperature);
      if (b.next === 'meeting') log.push(`Meeting ${follow}${time ? ' ' + time : ''}`);
      else if (b.next === 'quote') log.push(`Quote sent${deal ? ' ' + inr(deal) : ''} · follow-up ${follow}`);
      else if (b.next === 'negotiation') log.push(`Negotiating${deal ? ' ' + inr(deal) : ''} · follow-up ${follow}`);
      else log.push(`Call back ${follow}${time ? ' ' + time : ''}`);
      if (budget) log.push(`Budget ${budget}`);
    } else if (o === 'not_now') {
      if (!follow) return { error: 'Pick when to check back.' };
      setStage('Nurture'); up.follow_up = follow; up.follow_time = '';
      log.push(`check back ${follow}`);
    } else {
      const reason = b.lost_reason ? String(b.lost_reason) : '';
      if (!LOST_REASONS.includes(reason)) return { error: 'Choose why they are not interested.' };
      setStage('Lost'); up.lost_reason = reason; up.follow_up = null; up.follow_time = '';
      log.push(reason);
    }
    if (up.status && up.status !== 'Lost' && lead.lost_reason) up.lost_reason = '';
  }
  return { up, log: log.join(' · '), auto };
}

module.exports = { applyCall, OUTCOMES, NEXT_STEPS, LABEL, rupees, inr };
