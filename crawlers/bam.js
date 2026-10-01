/**
 * BAM (Brooklyn Academy of Music) Events Crawler (Fort Greene)
 * The calendar on bam.org loads /api/BAMApi/GetCalendarEventsByDayWithOnGoing, which returns
 * one row per production per day with that day's performance times. Each row becomes one event.
 * No browser required.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { resolveArea } from '../lib/nyc-area.js';
import { decodeEntities } from '../lib/event-filter.js';

const SOURCE_KEY  = 'bam';
const SOURCE      = 'BAM';
const ORGANIZER   = 'Brooklyn Academy of Music';
const BASE_URL    = 'https://www.bam.org';
const API_URL     = `${BASE_URL}/api/BAMApi/GetCalendarEventsByDayWithOnGoing`;
const WINDOW_DAYS = 14;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'application/json',
};
// The feed has no venue per row; the Peter Jay Sharp Building is BAM's main campus address.
const LOCATION = {
  name:    'BAM (Brooklyn Academy of Music)',
  address: '30 Lafayette Ave, Brooklyn, NY 11217',
  city:    'Brooklyn',
  lat:     40.6863,
  lng:     -73.9776,
};

/** Descriptions arrive double-encoded ('&amp;rsquo;'). */
function clean(text) {
  return decodeEntities(decodeEntities(String(text ?? '')).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 'MM/DD/YYYY' in NYC for the API's start/end parameters. */
function apiDate(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return `${p.month}/${p.day}/${p.year}`;
}

export function calendarUrl(now = new Date(), days = WINDOW_DAYS) {
  const end = new Date(now.getTime() + days * 86400000);
  return `${API_URL}?start=${apiDate(now)}&end=${apiDate(end)}`;
}

/** Map one calendar row; null when it has no title, page or performance time. */
export function mapRow(row) {
  const title = clean(row?.name);
  const performances = Array.isArray(row?.performances) ? row.performances : [];
  if (!title || !row?.moreLink || performances.length === 0) return null;

  const sourceUrl = new URL(row.moreLink, BASE_URL).href;
  const image = row.img ? new URL(row.img.replace(/\?.*$/, '?width=800&quality=80'), BASE_URL).href : null;
  const times = (row.performancesShort ?? []).filter(Boolean);
  return {
    // One row per production per day, so the day keeps the rows apart.
    id:          generateEventId(`${sourceUrl}#${row.day}`, title),
    source:      SOURCE,
    sourceUrl,
    title,
    description: clean(row.desc),
    startDate:   performances[0],
    endDate:     null,
    time:        times.length > 1 ? times.join(', ') : null,
    location:    { ...LOCATION },
    price:       { isFree: null, min: null, max: null, currency: 'USD' },
    categories:  String(row.genres ?? '').split(',').map(s => s.trim()).filter(Boolean),
    tags:        [],
    organizer:   ORGANIZER,
    attendance:  null,
    ticketUrl:   row.buyLink || sourceUrl,
    images:      image ? [image] : [],
    rawText:     null,
    ...resolveArea({ ...LOCATION, borough: 'Brooklyn' }),
  };
}

export async function crawl() {
  log('[bam] Starting crawl');
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  let events = [];

  try {
    const now = new Date();
    const res = await fetch(calendarUrl(now), { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();

    // Today's row lists performances that already happened; keep rows whose last one is still ahead.
    events = (Array.isArray(rows) ? rows : [])
      .filter(row => !row?.onGoing && (row?.performances ?? []).some(p => new Date(p) >= now))
      .map(mapRow)
      .filter(Boolean);
    log(`[bam] ${events.length} events from ${rows.length} calendar rows`);

    let result = { new: 0, updated: 0, errors: [] };
    if (events.length > 0) {
      result = await upsertEvents(events);
      errors.push(...result.errors);
    }
    log(`[bam] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);

    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   events.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[bam] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, { sourceName: SOURCE_KEY, eventsFound: events.length, errors });
    throw err;
  }
}
