'use strict';

// Stages a lead moves through. Fresh → (call) Not connected / Interested / Not interested → Won / Lost.
const STATUSES = ['Fresh', 'Not connected', 'Interested', 'Not interested', 'Won', 'Lost'];
const TEMPERATURES = ['Hot', 'Warm', 'Cold'];

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

module.exports = { STATUSES, TEMPERATURES, human, priorityFor };
