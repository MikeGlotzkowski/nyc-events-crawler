/**
 * America/New_York date/time normalization for event rows.
 *
 * Crawlers hand us one of:
 *   - 'YYYY-MM-DD'                      date-only
 *   - 'YYYY-MM-DDTHH:MM[:SS[.sss]]'     NYC wall-clock time (no offset, e.g. Socrata floating timestamps)
 *   - ISO string with Z / ±HH:MM offset a real instant
 *   - anything else Date can parse      read as a local calendar date (e.g. "September 28, 2026")
 *
 * start_date is the NYC calendar date. start_at is the real instant when a start time
 * is known; for date-only events it is `${date}T00:00:00Z`, matching the 0044_start_at
 * backfill (start_date::timestamptz in a UTC session).
 */

const TZ = 'America/New_York';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function nycParts(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function nycOffsetMs(utcMs) {
  const p = nycParts(new Date(utcMs));
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - utcMs;
}

/** NYC wall-clock time → Date (instant). */
export function nycWallToDate(y, m, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - nycOffsetMs(guess);
  const off2 = nycOffsetMs(t);
  if (guess - off2 !== t) t = guess - off2;
  return new Date(t);
}

function formatClock(h, mi) {
  return `${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/**
 * Parse the start of a free-text time like "7:00 PM", "7pm–9pm", "7-9 PM", "19:30".
 * @returns {{h:number, mi:number}|null}
 */
export function parseStartTime(time) {
  if (!time || typeof time !== 'string') return null;
  const m = time.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  let mer = m[3];
  // "7-9 PM": borrow the meridiem from later in the string
  if (!mer) mer = time.slice(m.index + m[0].length).match(/(a\.?m\.?|p\.?m\.?)/i)?.[1];
  if (!mer && !m[2]) return null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    const pm = mer[0].toLowerCase() === 'p';
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/**
 * Split a crawler date value into { date: 'YYYY-MM-DD'|null, instant: Date|null }.
 * instant is null when no start time is known.
 */
function parseDateValue(value) {
  if (value == null || value === '') return { date: null, instant: null };
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return { date: null, instant: null };
    value = value.toISOString();
  }
  const s = String(value).trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { date: s, instant: null };

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const [, y, mo, d, h, mi, off] = m;
    const instant = off ? new Date(s.replace(' ', 'T')) : nycWallToDate(+y, +mo, +d, +h, +mi);
    if (isNaN(instant.getTime())) return { date: null, instant: null };
    const p = nycParts(instant);
    // NYC midnight almost always means "no time given" (date-only sources serialised as timestamps)
    return { date: ymd(p.y, p.m, p.d), instant: (p.h === 0 && p.mi === 0) ? null : instant };
  }

  // Free text ("September 28, 2026", "9/28/2026"): Date parses it as a local calendar date.
  const d = new Date(s);
  if (isNaN(d.getTime())) return { date: null, instant: null };
  return { date: ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()), instant: null };
}

/**
 * @param {string|Date|null} startDate
 * @param {string|null} time  free-text time from the source, if any
 * @param {string|Date|null} [endDate]
 * @returns {{ startDate: string|null, startAt: string|null, endDate: string|null, time: string|null }}
 */
export function normalizeEventDates(startDate, time, endDate = null) {
  const start = parseDateValue(startDate);
  const end = parseDateValue(endDate);
  let startAt = null;
  let outTime = time ?? null;

  if (start.instant) {
    startAt = start.instant.toISOString();
    if (!outTime) {
      const p = nycParts(start.instant);
      outTime = formatClock(p.h, p.mi);
    }
  } else if (start.date) {
    const [y, mo, d] = start.date.split('-').map(Number);
    const t = parseStartTime(time);
    startAt = t ? nycWallToDate(y, mo, d, t.h, t.mi).toISOString() : `${start.date}T00:00:00.000Z`;
  }

  return { startDate: start.date, startAt, endDate: end.date, time: outTime };
}

/** Local calendar date of a Date as 'YYYY-MM-DD' (node-ical date-only values are local midnight). */
export function localYmd(date) {
  return ymd(date.getFullYear(), date.getMonth() + 1, date.getDate());
}
