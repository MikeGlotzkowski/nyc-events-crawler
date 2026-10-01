/**
 * DICE (dice.fm) shows, DJ nights and parties in New York
 * The New York browse pages are server-rendered Next.js; each carries its events in
 * __NEXT_DATA__ (about 20–30 upcoming events per page, no paging without a browser).
 * The main page plus the gig, DJ and party filters give the next few days of music.
 * Event pages are not fetched, so there is no description. No browser required.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { resolveArea } from '../lib/nyc-area.js';

const SOURCE_KEY = 'dice';
const SOURCE     = 'DICE';
const BASE_URL   = 'https://dice.fm';
const BROWSE_URL = `${BASE_URL}/browse/new_york-5bbf4db0f06331478e9b2c59`;
// Browse page path → categories the taxonomy understands. The main page is mostly music too.
const PAGES = [
  ['',             ['Music']],
  ['/music/gig',   ['Concert']],
  ['/music/dj',    ['Nightlife', 'Music']],
  ['/music/party', ['Nightlife']],
];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html',
};

/** The events in a browse page's __NEXT_DATA__. */
export function pageEvents(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__ on browse page');
  return JSON.parse(m[1])?.props?.pageProps?.events ?? [];
}

/** Prices are in cents; amount_from is 'from $x' when there are several ticket types. */
export function mapPrice(price) {
  const cents = price?.amount ?? price?.amount_from;
  if (!Number.isFinite(cents)) return { isFree: null, min: null, max: null, currency: 'USD' };
  return { isFree: cents === 0, min: cents / 100, max: null, currency: price.currency || 'USD' };
}

/** Map one browse-page event; null when it has no name, date or NYC venue. */
export function mapEvent(ev, categories = []) {
  const title = String(ev?.name ?? '').replace(/\s+/g, ' ').trim();
  const venue = ev?.venues?.[0];
  const startDate = ev?.dates?.event_start_date;
  if (!title || !ev?.id || !startDate || !venue?.name) return null;

  const location = {
    name:    venue.name.trim(),
    address: String(venue.address ?? '').trim() || null,
    city:    'New York',
    lat:     null,
    lng:     null,
  };
  // The New York city page also lists New Jersey and Long Island venues.
  const area = resolveArea(location);
  if (!area.borough) return null;

  const sourceUrl = `${BASE_URL}/event/${ev.id}`;
  return {
    id:          generateEventId(sourceUrl, title),
    source:      SOURCE,
    sourceUrl,
    title,
    description: String(ev.one_liner ?? '').trim(),
    startDate,
    endDate:     ev.dates.event_end_date ?? null,
    time:        null,
    location,
    price:       mapPrice(ev.price),
    categories,
    tags:        ev.status === 'sold-out' ? ['Sold out'] : [],
    organizer:   null,
    attendance:  null,
    ticketUrl:   sourceUrl,
    images:      ev.images?.square ? [ev.images.square] : [],
    rawText:     null,
    ...area,
  };
}

export async function crawl() {
  log('[dice] Starting crawl');
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  let events = [];

  try {
    const now = new Date();
    const byId = new Map(); // id → { ev, categories }
    for (const [path, categories] of PAGES) {
      try {
        const res = await fetch(BROWSE_URL + path, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        for (const ev of pageEvents(await res.text())) {
          const seen = byId.get(ev?.id) ?? { ev, categories: new Set() };
          categories.forEach(c => seen.categories.add(c));
          byId.set(ev?.id, seen);
        }
      } catch (err) {
        logError(`[dice] ${path || '/'} failed`, err);
        errors.push(`${path || '/'}: ${err.message}`);
      }
    }
    if (byId.size === 0) throw new Error('no events on any browse page');

    events = [...byId.values()]
      .filter(({ ev }) => new Date(ev?.dates?.event_end_date ?? ev?.dates?.event_start_date) >= now)
      .map(({ ev, categories }) => mapEvent(ev, [...categories]))
      .filter(Boolean);
    log(`[dice] ${events.length} NYC events from ${byId.size} listed`);

    let result = { new: 0, updated: 0, errors: [] };
    if (events.length > 0) {
      result = await upsertEvents(events);
      errors.push(...result.errors);
    }
    log(`[dice] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);

    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   events.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[dice] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, { sourceName: SOURCE_KEY, eventsFound: events.length, errors });
    throw err;
  }
}
