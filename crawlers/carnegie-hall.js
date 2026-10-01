/**
 * Carnegie Hall Events Crawler (Midtown)
 * Every page on carnegiehall.org sits behind a Queue-it waiting room for non-browser clients,
 * but sitemap.xml is served directly and lists each performance as
 *   /Calendar/YYYY/MM/DD/<Title-Slug>-HHMMAM|PM
 * so date, time and title all come from the URL. No description or image is available.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { resolveArea } from '../lib/nyc-area.js';

const SOURCE_KEY  = 'carnegie-hall';
const SOURCE      = 'Carnegie Hall';
const SITEMAP_URL = 'https://www.carnegiehall.org/sitemap.xml';
const WINDOW_DAYS = 30;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};
const LOCATION = {
  name:    'Carnegie Hall',
  address: '881 7th Ave, New York, NY 10019',
  city:    'New York',
  lat:     40.7651,
  lng:     -73.9799,
};

const PERFORMANCE_RE = /\/Calendar\/(\d{4})\/(\d{2})\/(\d{2})\/(.+)-(\d{2})(\d{2})(AM|PM)$/i;

/** Parse a performance URL; null for anything else in the sitemap. */
export function parsePerformanceUrl(url) {
  const m = String(url).match(PERFORMANCE_RE);
  if (!m) return null;
  const [, y, mo, d, slug, hh, mm, mer] = m;
  const h12 = +hh;
  if (h12 < 1 || h12 > 12 || +mm > 59) return null;
  const h = (h12 % 12) + (mer.toUpperCase() === 'PM' ? 12 : 0);
  return {
    title: slug.replace(/-+/g, ' ').trim(),
    // NYC wall clock; upsertEvent converts it to the real instant.
    startDate: `${y}-${mo}-${d}T${String(h).padStart(2, '0')}:${mm}`,
    time: `${h12}:${mm} ${mer.toUpperCase()}`,
  };
}

export function mapPerformance(url) {
  const p = parsePerformanceUrl(url);
  if (!p) return null;
  return {
    id:          generateEventId(url, p.title),
    source:      SOURCE,
    sourceUrl:   url,
    title:       p.title,
    description: '',
    startDate:   p.startDate,
    endDate:     null,
    time:        p.time,
    location:    { ...LOCATION },
    price:       { isFree: null, min: null, max: null, currency: 'USD' },
    categories:  ['Concert'],
    tags:        [],
    organizer:   SOURCE,
    attendance:  null,
    ticketUrl:   url,
    images:      [],
    rawText:     null,
    ...resolveArea({ ...LOCATION, borough: 'Manhattan' }),
  };
}

/** Performance URLs in the sitemap whose date falls between today and WINDOW_DAYS ahead (NYC dates). */
export function upcomingUrls(xml, now = new Date()) {
  const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
  const from = ymd(now);
  const to = ymd(new Date(now.getTime() + WINDOW_DAYS * 86400000));
  const urls = [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
  return [...new Set(urls)].filter(url => {
    const m = url.match(PERFORMANCE_RE);
    if (!m) return false;
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    return day >= from && day <= to;
  });
}

export async function crawl() {
  log('[carnegie-hall] Starting crawl');
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  let events = [];

  try {
    const res = await fetch(SITEMAP_URL, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    if (!xml.includes('<urlset')) throw new Error('Response is not a sitemap (waiting room?)');

    events = upcomingUrls(xml).map(mapPerformance).filter(Boolean);
    log(`[carnegie-hall] ${events.length} performances in the next ${WINDOW_DAYS} days`);

    let result = { new: 0, updated: 0, errors: [] };
    if (events.length > 0) {
      result = await upsertEvents(events);
      errors.push(...result.errors);
    }
    log(`[carnegie-hall] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);

    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   events.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[carnegie-hall] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, { sourceName: SOURCE_KEY, eventsFound: events.length, errors });
    throw err;
  }
}
