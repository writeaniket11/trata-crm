'use strict';

// Where the deal is. A call result (no answer, switched off…) is not a stage – it is logged on the lead.
// New → Trying to reach → Qualifying → Meeting booked → Quote sent → Negotiation → Won, plus Nurture (later) and Lost.
const STATUSES = ['New', 'Trying to reach', 'Qualifying', 'Meeting booked', 'Quote sent', 'Negotiation', 'Nurture', 'Won', 'Lost'];
const OPEN_STAGES = ['New', 'Trying to reach', 'Qualifying', 'Meeting booked', 'Quote sent', 'Negotiation', 'Nurture'];
const TEMPERATURES = ['Hot', 'Warm', 'Cold'];
const LOST_REASONS = ['Not interested', 'Budget too low', 'Chose someone else', 'Already has a vendor',
  'Unreachable', 'Not responding', 'Wrong number / Junk'];
const BUDGETS = ['Under ₹15k', '₹15k–50k', '₹50k+'];
// Rules for calls that did not connect.
const MAX_TRIES = 5;          // tries without a real conversation → Lost (Unreachable)
const MAX_CUTS = 3;           // times they cut the call → Lost (Not responding)
const FINAL_TRY_DAYS = 30;    // an Unreachable lead comes back once for a final try

const MAP = {
  new_website: 'New website',
  website_redesign: 'Website redesign',
  mobile_app: 'Mobile app',
  'whatsapp_automation_/_bulk_sms': 'WhatsApp automation / Bulk SMS',
  'branding_/_logo': 'Branding / Logo',
  'seo_/_digital_marketing': 'SEO / Digital marketing',
  immediately: 'Immediately',
  within_1_month: 'Within 1 month',
  just_exploring: 'Just exploring',
  other_business: 'Other business',
};

/** Turn Meta form values like "branding_/_logo" into "Branding / Logo". */
function human(v) {
  if (v === undefined || v === null) return '';
  v = String(v).trim();
  if (!v) return '';
  if (MAP[v]) return MAP[v];
  const s = v.replace(/_/g, ' ').replace(/\s+\/\s+/g, ' / ').replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Priority from "when do you want to start" (raw or human form). */
function priorityFor(start) {
  const s = String(start || '').toLowerCase().replace(/[\s_]+/g, ' ').trim();
  if (s === 'immediately') return 'Hot';
  if (s === 'within 1 month') return 'Warm';
  return 'Cold';
}

module.exports = { STATUSES, OPEN_STAGES, TEMPERATURES, LOST_REASONS, BUDGETS, MAX_TRIES, MAX_CUTS, FINAL_TRY_DAYS, human, priorityFor };
