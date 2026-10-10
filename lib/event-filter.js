/**
 * Deterministic non-event filter. Flagged events are still stored, but with
 * events.hidden_reason set, so the app never shows them and nothing is lost.
 */

const ENTITIES = { amp: '&', quot: '"', apos: "'", nbsp: ' ', '#038': '&', '#8211': '-', '#8212': '-', '#8216': "'", '#8217': "'", '#8220': '"', '#8221': '"',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', hellip: '...',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù', auml: 'ä', ouml: 'ö', uuml: 'ü', ccedil: 'ç',
  lt: '<', gt: '>', middot: '·', reg: '®', copy: '©', trade: '™' };

const MAX_CODE_POINT = 0x10ffff;

/**
 * Numeric entity -> character, or null when the digits are not a valid Unicode
 * code point. LiveWhale/iCal feeds mangle emoji into garbage runs such as
 * `&#549588310228495;`; String.fromCodePoint throws RangeError on those, which
 * aborted the whole ical-feeds crawl. Undecodable entities are kept verbatim.
 */
function decodeCodePoint(digits) {
  const n = Number(digits);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CODE_POINT) return null;
  return String.fromCodePoint(n);
}

/** Decode the HTML entities WordPress feeds leave in titles. */
export function decodeEntities(s) {
  return (s ?? '').replace(/&(#\d+|[a-z]+);/gi, (m, name) => {
    const key = name.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith('#')) return decodeCodePoint(key.slice(1)) ?? m;
    return m;
  });
}

/**
 * Plain text for storage: decodes entities until stable (feeds double- and
 * triple-encode, e.g. '&amp;nbsp;', '&amp;lt;em&amp;gt;'), drops HTML tags
 * and collapses runs of spaces (non-breaking included). Line breaks stay.
 */
export function cleanText(s) {
  let text = s ?? '';
  for (let i = 0; i < 3; i++) {
    const next = decodeEntities(text);
    if (next === text) break;
    text = next;
  }
  return text
    .replace(/<\/?(em|strong|i|b|u|a|span|sup|sub)\b[^>]*>/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/[ \t\u00a0]+/g, ' ').trim();
}

const TITLE_RULES = [
  ['cancelled', /\b(cancel+ed|postponed)\b/i],
  ['poll', /\bpolls?\b/i],
  ['volunteer_shift', /\bvolunteer(s|ing)?\b|^placepartner opportunit/i],
  // A venue or shop opening its doors is news, not something to attend.
  // Opening nights/receptions, grand openings and exhibitions stay.
  ['business_opening', /(^(re)?opening of\b|\b(re)?opening$|\bnow open$|\bopenings? in\b)/i, /\b(night|reception|party|gala|grand|exhibit\w*|gallery|show|parade|celebrat\w*|ceremony|festival)\b/i],
  ['application_window', /\bapplications?\b(.*\b(open|opening|due)\b)?$|\bdeadline\b|^registration for\b|^register now\b/i],
  ['policy_news', /\b(rule|law|policy) (implementation|takes effect|goes into effect)\b|\bballot\b|^enforcement of\b|\bprogram ends$/i],
  // News the blog extractor turns into "events": nothing to go to.
  ['service_change', /\b(train|subway|bus|ferry|service) (suspensions?|changes?|disruptions?|outages?)\b/i],
  ['civic_notice', /\b(rfps?|rfei|rfqs?)\b|\b(proposals?|responses) due\b|^press conference\b/i],
  ['court_case', /\b(sentencing|arraignment|court appearance|indictment)\b|^trial of\b/i],
  ['closure', /\b(closures?|observance)$|^(columbus|indigenous peoples['’]?|veterans|labor|memorial|presidents['’]?) day$/i],
  ['media_news', /\bseason \d+,? episode \d+\b|\bannouncement$|\b(movie|film) release$/i],
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
