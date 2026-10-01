/**
 * Lincoln Center Events Crawler (Upper West Side)
 * The campus calendar (lincolncenter.org/lincoln-center-at-home/calendar) loads one month at a
 * time from /ajaxCalendar/<Month YYYY>, whose calEvents array lists every show of every
 * resident organization (Met Opera, NY Phil, NYCB, Film at LC, Jazz at LC, Juilliard, ...).
 * One row per show per day; each becomes one event. No browser required.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { resolveArea } from '../lib/nyc-area.js';
import { decodeEntities } from '../lib/event-filter.js';
import { fetchPageImage } from '../lib/og-image.js';

const SOURCE_KEY  = 'lincoln-center';
const SOURCE      = 'Lincoln Center';
const BASE_URL    = 'https://www.lincolncenter.org';
const WINDOW_DAYS = 30;
const PAGE_FETCH_CONCURRENCY = 4;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
};

const CAMPUS = {
  name:    'Lincoln Center',
  address: '10 Lincoln Center Plaza, New York, NY 10023',
  city:    'New York',
  lat:     40.7725,
  lng:     -73.9835,
};
// Jazz at Lincoln Center plays at Columbus Circle, not on the campus.
const JAZZ_VENUE = {
  name:    'Jazz at Lincoln Center',
  address: '10 Columbus Circle, New York, NY 10019',
  city:    'New York',
  lat:     40.7685,
  lng:     -73.9829,
};

// organization slug → [organizer name, category the taxonomy understands]
const ORGS = {
  'the-metropolitan-opera':                          ['The Metropolitan Opera', 'Opera'],
  'new-york-philharmonic':                           ['New York Philharmonic', 'Classical Music'],
  'new-york-city-ballet':                            ['New York City Ballet', 'Dance'],
  'film-at-lincoln-center':                          ['Film at Lincoln Center', 'Film'],
  'jazz-at-lincoln-center':                          ['Jazz at Lincoln Center', 'Jazz'],
  'chamber-music-society-of-lincoln-center':         ['Chamber Music Society of Lincoln Center', 'Classical Music'],
  'lincoln-center-theater':                          ['Lincoln Center Theater', 'Theater'],
  'the-juilliard-school':                            ['The Juilliard School', null],
  'the-new-york-public-library-for-the-performing-arts': ['NYPL for the Performing Arts', null],
  'school-of-american-ballet':                       ['School of American Ballet', 'Dance'],
};
// typeClasses values the taxonomy understands ('other' says nothing)
const TYPE_CATEGORIES = {
  'theater': 'Theater', 'music': 'Music', 'classical-music': 'Classical Music',
  'jazz': 'Jazz', 'film': 'Film', 'dance': 'Dance', 'opera': 'Opera',
};

const MONTH_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', year: 'numeric' });

function clean(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Calendar endpoints for this month and next, e.g. /ajaxCalendar/October%202026. */
export function monthUrls(now = new Date()) {
  const next = new Date(now);
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return [now, next].map(d => `${BASE_URL}/ajaxCalendar/${encodeURIComponent(MONTH_FMT.format(d))}`);
}

/** Map one calEvents row; null for digital-only shows and rows without a title or start. */
export function mapShow(show) {
  const title = clean(show?.title);
  const start = show?.dateRange?.start;
  if (!title || !start || isNaN(new Date(start))) return null;
  if (show.eventTypeClass === 'filter-border-digital') return null;

  const sourceUrl = show.slug ? new URL(show.slug, BASE_URL).href : `${BASE_URL}/lincoln-center-at-home/calendar`;
  const [orgName, orgCategory] = ORGS[show.organization] ?? ['Lincoln Center', null];
  const categories = [...new Set([
    orgCategory,
    ...(show.typeClasses ?? []).map(t => TYPE_CATEGORIES[t]),
  ].filter(Boolean))];
  const times = (show.time ?? []).filter(Boolean);
  const venue = show.organization === 'jazz-at-lincoln-center' ? JAZZ_VENUE : CAMPUS;

  return {
    // A show page lists every date, so the start keeps the days apart.
    id:          generateEventId(`${sourceUrl}#${start}`, title),
    source:      SOURCE,
    sourceUrl,
    title,
    description: clean(show.h2),
    startDate:   start,
    endDate:     null,
    time:        times.length > 1 ? times.join(', ') : null,
    location:    { ...venue },
    price:       { isFree: null, min: null, max: null, currency: 'USD' },
    categories,
    tags:        [],
    organizer:   orgName,
    attendance:  null,
    ticketUrl:   sourceUrl,
    images:      [],
    rawText:     null,
    ...resolveArea({ ...venue, borough: 'Manhattan' }),
  };
}

/** Keep shows starting between now and WINDOW_DAYS ahead. */
export function inWindow(events, now = new Date()) {
  const from = now.getTime();
  const to = from + WINDOW_DAYS * 86400000;
  return events.filter(e => {
    const ms = new Date(e.startDate).getTime();
    return ms >= from && ms <= to;
  });
}

/** One og:image lookup per show page, shared by all its dates. */
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
  log('[lincoln-center] Starting crawl');
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  let events = [];

  try {
    const now = new Date();
    const all = [];
    for (const url of monthUrls(now)) {
      try {
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        all.push(...(data?.calEvents ?? []).map(mapShow).filter(Boolean));
      } catch (err) {
        logError(`[lincoln-center] Fetch failed: ${url}`, err);
        errors.push(`${url}: ${err.message}`);
      }
    }

    events = inWindow(all, now);
    await addPageImages(events);
    log(`[lincoln-center] ${events.length} events in window, ${events.filter(e => e.images.length).length} with images`);

    let result = { new: 0, updated: 0, errors: [] };
    if (events.length > 0) {
      result = await upsertEvents(events);
      errors.push(...result.errors);
    }
    log(`[lincoln-center] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);

    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   events.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[lincoln-center] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, { sourceName: SOURCE_KEY, eventsFound: events.length, errors });
    throw err;
  }
}
