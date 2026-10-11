/**
 * One recurrence model for every crawler (B2).
 *
 * A recurring event used to be three different concepts in this codebase:
 *   - iCal RRULEs were expanded ad hoc in ical-feeds.js and calendar-harvest.js;
 *   - the libraries faked recurrence with an `id#timestamp` suffix;
 *   - the app re-grouped a series visually with its own `seriesKey`.
 *
 * This module is the shared model: normalise an RRULE or an "every X" phrase,
 * give a whole series one stable `series_id`, number each occurrence, and cap a
 * long series so a daily calendar cannot flood the feed.
 *
 * Nothing here touches storage or dates — it is pure string/number work, so the
 * crawlers keep owning timezone-correct instant maths (lib/nyc-time.js).
 */
import crypto from 'crypto';

/** Occurrences kept per series per crawl. A 90-day daily series stops at this. */
export const SERIES_CAP = 60;

const FREQ = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' };

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ABBR = { su: 'sunday', mo: 'monday', tu: 'tuesday', we: 'wednesday', th: 'thursday', fr: 'friday', sa: 'saturday' };

/**
 * An iCalendar RRULE value ("FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2") → a normalised
 * shape, or null when there is no FREQ. Accepts node-ical's rrule object too.
 * @returns {{freq:string, interval:number, byDay:string[], count:number|null, until:string|null, raw:string}|null}
 */
export function parseRrule(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!text || !text.includes('FREQ=')) return null;
  const parts = {};
  for (const seg of text.split(';')) {
    const [k, v] = seg.split('=');
    if (k && v != null) parts[k.trim().toUpperCase()] = v.trim();
  }
  if (!parts.FREQ) return null;
  return {
    freq: FREQ[parts.FREQ.toUpperCase()] ?? parts.FREQ.toLowerCase(),
    interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1,
    byDay: (parts.BYDAY ?? '').split(',').map((d) => DAY_ABBR[d.slice(-2).toLowerCase()] ?? d.trim().toLowerCase()).filter(Boolean),
    count: parts.COUNT ? Number(parts.COUNT) : null,
    until: parts.UNTIL ?? null,
    raw: text,
  };
}

/**
 * A free-text cadence ("every Wednesday", "weekly", "every 2 weeks", "daily",
 * "monthly", "every other Saturday") → a normalised shape, or null.
 * @returns {{freq:string, interval:number, byDay:string[]}|null}
 */
export function parseCadence(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t) return null;

  // explicit frequency words
  const word = /\b(daily|weekly|monthly|yearly|annual|annually)\b/.exec(t);
  const nth = /\bevery\s+(?:other\s+)?(\d+)\s+(day|week|month|year)s?\b/.exec(t);
  const everyNth = /\bevery\s+other\s+(day|week|month|year)s?\b/.exec(t);

  const days = DAY_NAMES.filter((d) => new RegExp(`\\b${d}\\b`).test(t));
  // Three-letter forms ("every Wed", "Tue and Thu") are common in free text; only
  // trust them in an "every ..." phrase so a stray word cannot look like a day.
  if (/\bevery\b/.test(t)) {
    for (const m of t.matchAll(/\b(mon|tue|wed|thu|fri|sat|sun)\b/g)) {
      const d = { mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday' }[m[1]];
      if (d && !days.includes(d)) days.push(d);
    }
  }

  if (nth) {
    const unit = nth[2];
    const freq = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[unit];
    return { freq, interval: Number(nth[1]), byDay: days };
  }
  if (everyNth) {
    const freq = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[everyNth[1]];
    return { freq, interval: 2, byDay: days };
  }
  if (/\bevery\s+other\b/.test(t) && days.length > 0) {
    return { freq: 'weekly', interval: 2, byDay: days };
  }
  if (days.length > 0 && /\bevery\b/.test(t)) return { freq: 'weekly', interval: 1, byDay: days };
  if (word) {
    const freq = word[1] === 'annual' || word[1] === 'annually' ? 'yearly' : word[1];
    return { freq, interval: 1, byDay: days };
  }
  return null;
}

/**
 * A stable id shared by every occurrence of one series.
 * @param {{source:string, selector:string}} parts
 */
export function seriesId({ source, selector }) {
  return crypto.createHash('sha1').update(`${source}\u0000${selector}`).digest('hex').slice(0, 16);
}

/** Keep at most `cap` occurrences (order preserved). */
export function capOccurrences(list, cap = SERIES_CAP) {
  return Array.isArray(list) && list.length > cap ? list.slice(0, cap) : list;
}

/**
 * A recurrence selector from what a crawler knows, preferring a stable series
 * key over a per-occurrence one: an explicit series key, else the event URL
 * (a whole series shares its page), else the title.
 */
export function seriesSelector({ seriesKey = null, url = null, title = null, fallback = null } = {}) {
  return seriesKey || url || title || fallback || '';
}
