/**
 * Deterministic non-event filter. Flagged events are still stored, but with
 * events.hidden_reason set, so the app never shows them and nothing is lost.
 */

const ENTITIES = { amp: '&', quot: '"', apos: "'", nbsp: ' ', '#038': '&', '#8211': '-', '#8212': '-', '#8216': "'", '#8217': "'", '#8220': '"', '#8221': '"',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', hellip: '...',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  agrave: 'à', egrave: 'è', auml: 'ä', ouml: 'ö', uuml: 'ü', ccedil: 'ç' };

/** Decode the HTML entities WordPress feeds leave in titles. */
export function decodeEntities(s) {
  return (s ?? '').replace(/&(#\d+|[a-z]+);/gi, (m, name) => {
    const key = name.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)));
    return m;
  });
}

const TITLE_RULES = [
  ['cancelled', /\b(cancel+ed|postponed)\b/i],
  ['poll', /\bpolls?\b/i],
  ['volunteer_shift', /\bvolunteer(s|ing)?\b|^placepartner opportunit/i],
  // A venue or shop opening its doors is news, not something to attend.
  // Opening nights/receptions, grand openings and exhibitions stay.
  ['business_opening', /(^(re)?opening of\b|\b(re)?opening$|\bnow open$)/i, /\b(night|reception|party|gala|grand|exhibit\w*|gallery|show|parade|celebrat\w*|ceremony|festival)\b/i],
  ['application_window', /\bapplications?\b(.*\b(open|opening|due)\b)?$|\bdeadline\b|^registration for\b|^register now\b/i],
  ['policy_news', /\b(rule|law|policy) (implementation|takes effect|goes into effect)\b|\bballot\b/i],
];

// "[OCT 14 EVENT CANCELED] ..." or "has been postponed" with no new date.
// "postponed from Sunday to Oct. 4" is a real event on its new date.
const CANCELLED_TAG = /^\s*\[[^\]]*\b(cancel+ed|postponed)\b/i;
const CANCELLED_DESC = /\bhas been (postponed|cancel+ed)\b/i;
const RESCHEDULED = /\b(postponed|moved|rescheduled) (from|to|until) [^.]*\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun|\d)/i;

/**
 * @param {{ title?: string, description?: string }} event
 * @returns {string|null}  rule name if this is not a real event, else null
 */
export function nonEventReason(event) {
  const title = decodeEntities(event.title).trim();
  for (const [name, re, unless] of TITLE_RULES) {
    if (re.test(title) && !(unless && unless.test(title))) return name;
  }
  const desc = decodeEntities(event.description);
  if (CANCELLED_TAG.test(desc) || (CANCELLED_DESC.test(desc) && !RESCHEDULED.test(desc))) return 'cancelled';
  return null;
}
