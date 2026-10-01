/**
 * Van Cortlandt Park Alliance WordPress Events Calendar Crawler
 * Uses The Events Calendar REST API (tribe/events/v1), same shape as crawlers/riverside-park.js.
 * No browser required — pure HTTP.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { decodeEntities } from '../lib/event-filter.js';
import { nycWallToDate } from '../lib/nyc-time.js';

const SOURCE_KEY   = 'van-cortlandt-park';
const SOURCE       = 'Van Cortlandt Park';
const ORGANIZER    = 'Van Cortlandt Park Alliance';
const BASE_URL     = 'https://www.vancortlandt.org/wp-json/tribe/events/v1/events';
const PER_PAGE     = 50;
const WINDOW_DAYS  = 30;
const TZ           = 'America/New_York';
const DEFAULT_VENUE = 'Van Cortlandt Park';
const NEIGHBORHOOD = 'Van Cortlandt Park';
const BOROUGH      = 'Bronx';

const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
});

function stripHtml(html) {
  if (!html) return '';
  // Tags first, then entities — WordPress titles/descriptions carry &#8217; &#8211; &amp; etc.
  return decodeEntities(
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** '2026-09-30 09:00:00' (NYC wall clock) → the real instant. */
function toInstant(wallClock) {
  if (!wallClock) return null;
  const m = String(wallClock).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const ms = nycWallToDate(+y, +mo, +d, +(h ?? 0), +(mi ?? 0)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function dayOf(wallClock, details) {
  if (wallClock) return wallClock.slice(0, 10);
  if (details?.year && details?.month && details?.day) {
    return `${details.year}-${String(details.month).padStart(2, '0')}-${String(details.day).padStart(2, '0')}`;
  }
  return null;
}

function parseStartDate(event) {
  const day = dayOf(event.start_date ?? null, event.start_date_details);
  if (!day) return null;
  // All-day events keep the calendar date; timed ones keep NYC wall clock (upsertEvent converts).
  if (event.all_day) return day;
  return event.start_date
    ? event.start_date.replace(' ', 'T')
    : detailsStamp(event.start_date_details);
}

function parseEndDate(event) {
  const day = dayOf(event.end_date ?? null, event.end_date_details);
  if (!day) return null;
  if (event.all_day) return day;
  return event.end_date ? event.end_date.replace(' ', 'T') : detailsStamp(event.end_date_details);
}

function detailsStamp(d) {
  return `${dayOf(null, d)}T${d.hour ?? '00'}:${d.minutes ?? '00'}:${d.seconds ?? '00'}`;
}

/** '9:00 AM' or '9:00 AM–12:00 PM' in NYC wall clock; null for all-day events. */
function formatTimeRange(event) {
  if (event.all_day) return null;
  const start = toInstant(event.start_date);
  if (start === null) return null;
  const end = toInstant(event.end_date);
  const startLabel = clockFmt.format(start);
  return end !== null && end > start ? `${startLabel}–${clockFmt.format(end)}` : startLabel;
}

function parsePriceText(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { isFree: true, min: 0, max: 0, currency: 'USD' };
  if (trimmed.toLowerCase().includes('free')) return { isFree: true, min: 0, max: 0, currency: 'USD' };
  const match = trimmed.match(/\$(\d+(?:\.\d{2})?)/);
  if (match) return { isFree: false, min: parseFloat(match[1]), max: parseFloat(match[1]), currency: 'USD' };
  return { isFree: null, min: null, max: null, currency: 'USD' };
}

export function mapEvent(event) {
  const venue = Array.isArray(event.venue) ? null : (event.venue ?? null);

  const locationName = venue?.venue ?? DEFAULT_VENUE;
  const locationAddress = [
    venue?.address,
    venue?.city && venue?.zip ? `${venue.city}, NY ${venue.zip}` : (venue?.city ?? null),
  ].filter(Boolean).join(', ') || null;

  const lat = venue?.geo_lat ? parseFloat(venue.geo_lat) : null;
  const lng = venue?.geo_lng ? parseFloat(venue.geo_lng) : null;

  const title = stripHtml(event.title ?? '');
  const url   = event.url ?? '';

  return {
    id:          generateEventId(url, title),
    source:      SOURCE,
    sourceUrl:   url,
    title,
    description: stripHtml(event.description ?? ''),
    startDate:   parseStartDate(event),
    endDate:     parseEndDate(event),
    time:        formatTimeRange(event),
    location: {
      name:    locationName,
      address: locationAddress,
      city:    venue?.city ?? 'New York',
      lat:     isNaN(lat) ? null : lat,
      lng:     isNaN(lng) ? null : lng,
    },
    price:       parsePriceText(event.cost),
    categories:  (event.categories ?? []).map(c => c?.name).filter(Boolean),
    tags:        [],
    organizer:   ORGANIZER,
    attendance:  null,
    ticketUrl:   url,
    images:      event.image?.url ? [event.image.url] : [],
    rawText:     null,
    neighborhood: NEIGHBORHOOD,
    borough:     BOROUGH,
  };
}

/** REST query for one page of the forward window. */
export function pageUrl(page, today = new Date(), days = WINDOW_DAYS) {
  const end = new Date(today);
  end.setDate(end.getDate() + days);
  return `${BASE_URL}?per_page=${PER_PAGE}&page=${page}`
    + `&start_date=${today.toISOString().slice(0, 10)}&end_date=${end.toISOString().slice(0, 10)}`;
}

/** Keep events starting between now and WINDOW_DAYS ahead — the API window is advisory. */
export function inWindow(events, now = new Date()) {
  const startMs = now.getTime();
  const endMs = startMs + WINDOW_DAYS * 86400000;
  return events.filter(e => {
    const ms = toInstant(e.startDate);
    // All-day events start at NYC midnight; keep today's instead of dropping them
    const from = e.startDate?.length === 10 ? startMs - 86400000 : startMs;
    return ms !== null && ms >= from && ms <= endMs;
  });
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function crawl() {
  log('[van-cortlandt-park] Starting crawl');
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  const allEvents = [];

  try {
    const now = new Date();

    for (let page = 1; ; page++) {
      const url = pageUrl(page, now);
      log(`[van-cortlandt-park] Fetching page ${page}: ${url}`);

      let data;
      try {
        data = await fetchPage(url);
      } catch (fetchErr) {
        logError(`[van-cortlandt-park] Fetch failed on page ${page}`, fetchErr);
        errors.push(fetchErr.message);
        break;
      }

      const events = data?.events ?? [];
      log(`[van-cortlandt-park]   Page ${page}: ${events.length} events`);

      for (const ev of events) {
        try {
          allEvents.push(mapEvent(ev));
        } catch (err) {
          logError('[van-cortlandt-park] Failed to map event', err);
          errors.push(`map error: ${err.message}`);
        }
      }

      const totalPages = Number(data?.total_pages ?? 1) || 1;
      if (page >= totalPages || events.length === 0) break;
    }

    log(`[van-cortlandt-park] Total events collected: ${allEvents.length}`);

    const kept = inWindow(allEvents, now);
    log(`[van-cortlandt-park] ${kept.length} events within the ${WINDOW_DAYS}-day window`);

    let result = { new: 0, updated: 0, errors: [] };
    if (kept.length > 0) {
      result = await upsertEvents(kept);
      errors.push(...result.errors);
    }

    log(`[van-cortlandt-park] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);

    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   kept.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[van-cortlandt-park] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   allEvents.length,
      eventsNew:     0,
      eventsUpdated: 0,
      errors,
    });
    throw err;
  }
}