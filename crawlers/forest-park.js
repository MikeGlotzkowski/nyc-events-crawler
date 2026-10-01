/**
 * Forest Park Trust Events Crawler (Queens)
 * Squarespace site — the /events?format=json endpoint returns the raw collection
 * with an `upcoming` array. No browser required — pure HTTP.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { decodeEntities } from '../lib/event-filter.js';

const SOURCE_KEY = 'forest-park';
const SOURCE     = 'Forest Park Trust';
const ORGANIZER  = 'Forest Park Trust';
const BASE_URL   = 'https://www.forestparktrust.org';
const EVENTS_URL = `${BASE_URL}/events?format=json`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};
const NEIGHBORHOOD = 'Forest Park';
const BOROUGH      = 'Queens';
const WINDOW_DAYS  = 30;
const MAX_DESC     = 2000;

const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Squarespace sends epoch ms as a number or a numeric string → ISO instant. */
export function toIsoInstant(value) {
  const ms = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** '10:00 AM' in NYC wall-clock time, whatever the raw offset was. */
export function nycTimeLabel(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return TIME_FMT.format(date).replace(/[\u202f\u00a0]/g, ' ');
}

/** '10:00 AM–12:00 PM', or just the start label when the end is unknown. */
export function timeRangeLabel(startIso, endIso) {
  const start = nycTimeLabel(startIso);
  const end   = nycTimeLabel(endIso);
  if (start && end) return `${start}–${end}`;
  return start;
}

function stringList(list) {
  return Array.isArray(list) ? list.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()) : [];
}

function parseCoords(location) {
  const lat = Number(location?.markerLat);
  const lng = Number(location?.markerLng);
  return {
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
  };
}

/** Map one Squarespace collection item to the shared event shape (null if unusable). */
export function mapItem(item) {
  const title = decodeEntities(item?.title ?? '').trim();
  const fullUrl = item?.fullUrl ?? '';
  const sourceUrl = fullUrl ? `${BASE_URL}${fullUrl}` : null;
  const startDate = toIsoInstant(item?.startDate);
  if (!title || !sourceUrl || !startDate) return null;

  const endDate     = toIsoInstant(item?.endDate);
  const description = (stripHtml(item?.excerpt) || stripHtml(item?.body)).slice(0, MAX_DESC);
  const venue       = item?.location ?? null;
  const address     = [venue?.addressLine1, venue?.addressLine2].filter(v => v && v.trim()).join(', ') || null;

  return {
    id:          generateEventId(sourceUrl, title),
    source:      SOURCE,
    sourceUrl,
    title,
    description,
    startDate,
    endDate,
    time:        timeRangeLabel(startDate, endDate),
    location: {
      name:    venue?.addressTitle?.trim() || 'Forest Park',
      address,
      city:    'New York',
      ...parseCoords(venue),
    },
    price:        { isFree: null, min: null, max: null, currency: 'USD' },
    categories:   stringList(item?.categories),
    tags:         stringList(item?.tags),
    organizer:    ORGANIZER,
    attendance:   null,
    ticketUrl:    sourceUrl,
    images:       item?.assetUrl ? [item.assetUrl] : [],
    rawText:      null,
    neighborhood: NEIGHBORHOOD,
    borough:      BOROUGH,
  };
}

/** Keep events starting between now and `windowDays` from now. */
export function withinWindow(startDate, now = Date.now(), windowDays = WINDOW_DAYS) {
  const start = Date.parse(startDate ?? '');
  if (!Number.isFinite(start)) return false;
  return start >= now && start <= now + windowDays * 86400000;
}

/** Fetch the upcoming collection. Never throws — failures come back in `errors`. */
async function fetchUpcoming() {
  const errors = [];

  let res;
  try {
    res = await fetch(EVENTS_URL, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  } catch (fetchErr) {
    logError(`[${SOURCE_KEY}] Network error`, fetchErr);
    errors.push(fetchErr.message);
    return { items: [], errors };
  }

  if (!res.ok) {
    logError(`[${SOURCE_KEY}] HTTP ${res.status}`, null);
    errors.push(`HTTP ${res.status}`);
    return { items: [], errors };
  }

  let data;
  try {
    data = await res.json();
  } catch (jsonErr) {
    logError(`[${SOURCE_KEY}] Failed to parse JSON response`, jsonErr);
    errors.push(`JSON parse error: ${jsonErr.message}`);
    return { items: [], errors };
  }

  return { items: data?.upcoming ?? [], errors };
}

export async function crawl() {
  log(`[${SOURCE_KEY}] Starting crawl`);
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  const allEvents = [];

  try {
    log(`[${SOURCE_KEY}] Fetching ${EVENTS_URL}`);
    const { items, errors: fetchErrors } = await fetchUpcoming();
    errors.push(...fetchErrors);
    log(`[${SOURCE_KEY}]   ${items.length} upcoming items`);

    const now = Date.now();
    for (const item of items) {
      try {
        const event = mapItem(item);
        if (!event) continue;
        if (!withinWindow(event.startDate, now)) continue;
        allEvents.push(event);
      } catch (err) {
        logError(`[${SOURCE_KEY}] Failed to map event`, err);
        errors.push(`map error: ${err.message}`);
      }
    }

    log(`[${SOURCE_KEY}] Total events collected: ${allEvents.length}`);

    if (allEvents.length > 0) {
      const result = await upsertEvents(allEvents);
      errors.push(...result.errors);
      log(`[${SOURCE_KEY}] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);

      await finishCrawlRun(runId, {
        sourceName:    SOURCE_KEY,
        eventsFound:   allEvents.length,
        eventsNew:     result.new,
        eventsUpdated: result.updated,
        errors,
      });
    } else {
      log(`[${SOURCE_KEY}] No events found — finishing with 0`);
      await finishCrawlRun(runId, {
        sourceName:    SOURCE_KEY,
        eventsFound:   0,
        eventsNew:     0,
        eventsUpdated: 0,
        errors,
      });
    }
  } catch (err) {
    logError(`[${SOURCE_KEY}] Fatal error`, err);
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
