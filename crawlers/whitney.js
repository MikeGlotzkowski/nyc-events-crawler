/**
 * Whitney Museum of American Art Events Crawler (Meatpacking District)
 * whitney.org/api/events is a JSON:API list of single occurrences; ransack filters
 * (q[start_time_gteq] / q[start_time_lteq]) narrow it to the forward window.
 * Images come from each event page's og:image. No browser required.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { resolveArea } from '../lib/nyc-area.js';
import { decodeEntities } from '../lib/event-filter.js';
import { fetchPageImage } from '../lib/og-image.js';

const SOURCE_KEY  = 'whitney';
const SOURCE      = 'Whitney Museum';
const ORGANIZER   = 'Whitney Museum of American Art';
const BASE_URL    = 'https://whitney.org';
const API_URL     = `${BASE_URL}/api/events`;
const WINDOW_DAYS = 30;
const MAX_PAGES   = 20;
const PAGE_FETCH_CONCURRENCY = 4;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};
const LOCATION = {
  name:    'Whitney Museum of American Art',
  address: '99 Gansevoort St, New York, NY 10014',
  city:    'New York',
  lat:     40.7396,
  lng:     -74.0089,
};

// Online-only programs and members-only events are not something the app's users can just attend.
const SKIP_TITLE_RE = /\bonline\b|\bvirtual\b|\bmembers?\b/i;

const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
});

function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(String(html).replace(/<br\s*\/?>|<\/p>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** '6:30 PM' or '6:30 PM–9:30 PM' in NYC wall clock. */
export function timeLabel(startIso, endIso) {
  const start = new Date(startIso);
  if (isNaN(start)) return null;
  const end = endIso ? new Date(endIso) : null;
  const fmt = (d) => clockFmt.format(d).replace(/[  ]/g, ' ');
  return end && end > start ? `${fmt(start)}–${fmt(end)}` : fmt(start);
}

/** Map one API record to the shared event shape; null when unusable or not open to the public. */
export function mapEvent(record) {
  const a = record?.attributes ?? {};
  const title = stripHtml(a.title);
  if (!title || !a.start_time || !a.url) return null;
  if (SKIP_TITLE_RE.test(title)) return null;

  const sourceUrl = new URL(a.url, BASE_URL).href;
  const openTo = stripHtml(a.open_to);
  return {
    // Occurrences share one page URL, so the occurrence id keeps them apart.
    id:          generateEventId(`${API_URL}/${a.id ?? record.id}`, title),
    source:      SOURCE,
    sourceUrl,
    title,
    description: stripHtml(a.description),
    startDate:   a.start_time,
    endDate:     a.end_time ?? null,
    time:        timeLabel(a.start_time, a.end_time),
    location:    { ...LOCATION },
    price:       { isFree: null, min: null, max: null, currency: 'USD' },
    categories:  ['Museum'],
    tags:        openTo ? [openTo] : [],
    organizer:   ORGANIZER,
    attendance:  null,
    ticketUrl:   sourceUrl,
    images:      [],
    rawText:     null,
    ...resolveArea({ ...LOCATION, borough: 'Manhattan' }),
  };
}

export function pageUrl(page, now = new Date(), days = WINDOW_DAYS) {
  const end = new Date(now.getTime() + days * 86400000);
  const params = new URLSearchParams({
    'q[start_time_gteq]': now.toISOString(),
    'q[start_time_lteq]': end.toISOString(),
    page: String(page),
  });
  return `${API_URL}?${params}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** One og:image lookup per event page, shared by all its occurrences. */
async function addPageImages(events) {
  const urls = [...new Set(events.map(e => e.sourceUrl))];
  const images = new Map();
  for (let i = 0; i < urls.length; i += PAGE_FETCH_CONCURRENCY) {
    await Promise.all(urls.slice(i, i + PAGE_FETCH_CONCURRENCY).map(async (url) => {
      images.set(url, await fetchPageImage(url));
    }));
  }
  for (const e of events) {
    const image = images.get(e.sourceUrl);
    if (image) e.images = [image];
  }
}

export async function crawl() {
  log('[whitney] Starting crawl');
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  const events = [];

  try {
    const now = new Date();
    for (let page = 1; page <= MAX_PAGES; page++) {
      let data;
      try {
        data = await fetchJson(pageUrl(page, now));
      } catch (err) {
        logError(`[whitney] Fetch failed on page ${page}`, err);
        errors.push(err.message);
        break;
      }
      const records = data?.data ?? [];
      for (const record of records) {
        const event = mapEvent(record);
        if (event) events.push(event);
      }
      if (!data?.links?.next || records.length === 0) break;
    }

    await addPageImages(events);
    log(`[whitney] ${events.length} events, ${events.filter(e => e.images.length).length} with images`);

    let result = { new: 0, updated: 0, errors: [] };
    if (events.length > 0) {
      result = await upsertEvents(events);
      errors.push(...result.errors);
    }
    log(`[whitney] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);

    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   events.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[whitney] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, { sourceName: SOURCE_KEY, eventsFound: events.length, errors });
    throw err;
  }
}
