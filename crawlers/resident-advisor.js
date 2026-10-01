/**
 * Resident Advisor (ra.co) club nights and DJ shows in New York
 * The ra.co listings pages load their data from the public GraphQL endpoint; area 8 is
 * New York City. ra.co pages themselves sit behind a bot check, the GraphQL endpoint does not.
 * Listings repeat a multi-day event on each day, so events are kept once by RA event id.
 * No browser required.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { resolveArea } from '../lib/nyc-area.js';

const SOURCE_KEY  = 'resident-advisor';
const SOURCE      = 'Resident Advisor';
const BASE_URL    = 'https://ra.co';
const API_URL     = `${BASE_URL}/graphql`;
const AREA_NYC    = 8;
const WINDOW_DAYS = 14;
const PAGE_SIZE   = 50;
const MAX_PAGES   = 20;
const MAX_DESCRIPTION = 1500;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
  Referer: `${BASE_URL}/events/us/newyork`,
};

const QUERY = `query GET_EVENT_LISTINGS($filters: FilterInputDtoInput, $pageSize: Int, $page: Int) {
  eventListings(filters: $filters, pageSize: $pageSize, page: $page) {
    data { id event {
      id title startTime endTime contentUrl cost content attending
      images { filename type }
      genres { name }
      venue { name address location { latitude longitude } }
    } }
    totalResults
  }
}`;

/** 'YYYY-MM-DD' in NYC. */
function nycDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);
}

export function requestBody(now, page) {
  return JSON.stringify({
    operationName: 'GET_EVENT_LISTINGS',
    variables: {
      filters: {
        areas: { eq: AREA_NYC },
        listingDate: { gte: nycDate(now), lte: nycDate(new Date(now.getTime() + WINDOW_DAYS * 86400000)) },
      },
      pageSize: PAGE_SIZE,
      page,
    },
    query: QUERY,
  });
}

/** Free-text cost ('$20+', '29.50-55.50', '0', '$10 / $15', '') → price. */
export function parsePrice(cost) {
  const nums = [...String(cost ?? '').matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
  if (nums.length === 0) return { isFree: null, min: null, max: null, currency: 'USD' };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { isFree: max === 0, min, max: nums.length > 1 ? max : null, currency: 'USD' };
}

/** RA venue coordinates are often 0,0, a whole degree or rounded to 2 places; keep only precise ones. */
function preciseCoord(value) {
  return Number.isFinite(value) && value !== 0 && Math.round(value * 1000) / 1000 !== value ? value : null;
}

/** The promoter's text, without the door policy and accessibility notes RA venues append after '///'. */
function describe(content) {
  const text = String(content ?? '').split(/\n\s*\/{3,}/)[0].replace(/\s+/g, ' ').trim();
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : text;
}

/** Map one listing's event; null when it has no title, time or NYC venue. */
export function mapEvent(ev) {
  const title = String(ev?.title ?? '').trim();
  const venue = ev?.venue;
  if (!title || !ev?.startTime || !ev?.contentUrl || !venue?.name || /^TBA\b/i.test(venue.name)) return null;

  let lat = preciseCoord(venue.location?.latitude);
  let lng = preciseCoord(venue.location?.longitude);
  if (lat == null || lng == null) lat = lng = null;
  const location = {
    name:    venue.name.trim(),
    address: String(venue.address ?? '').replace(/;\s*/g, ', ').trim() || null,
    city:    'New York',
    lat,
    lng,
  };
  // Area 8 also covers New Jersey and Long Island venues; only NYC boroughs stay.
  const area = resolveArea(location);
  if (!area.borough) return null;

  const sourceUrl = new URL(ev.contentUrl, BASE_URL).href;
  const flyer = (ev.images ?? []).find(i => i?.type === 'FLYERFRONT') ?? ev.images?.[0];
  return {
    id:          generateEventId(sourceUrl, title),
    source:      SOURCE,
    sourceUrl,
    title,
    description: describe(ev.content),
    startDate:   ev.startTime,
    endDate:     ev.endTime ?? null,
    time:        null,
    location,
    price:       parsePrice(ev.cost),
    categories:  ['Nightlife', 'Music'],
    tags:        (ev.genres ?? []).map(g => g?.name).filter(Boolean),
    organizer:   null,
    attendance:  ev.attending ?? null,
    ticketUrl:   sourceUrl,
    images:      flyer?.filename ? [flyer.filename] : [],
    rawText:     null,
    ...area,
  };
}

export async function crawl() {
  log('[resident-advisor] Starting crawl');
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  let events = [];

  try {
    const now = new Date();
    const today = nycDate(now);
    const byId = new Map();
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(API_URL, {
        method: 'POST', headers: HEADERS, body: requestBody(now, page), signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.errors?.length) throw new Error(`GraphQL: ${body.errors[0].message}`);
      const listings = body.data?.eventListings;
      total = listings?.totalResults ?? 0;
      const before = byId.size;
      for (const { event } of listings?.data ?? []) {
        if (event?.id && !byId.has(event.id)) byId.set(event.id, event);
      }
      if (byId.size === before || page * PAGE_SIZE >= total) break;
    }

    // A long-running event is listed on every day it spans; keep those that start from today on.
    events = [...byId.values()]
      .filter(ev => String(ev.startTime).slice(0, 10) >= today)
      .map(mapEvent)
      .filter(Boolean);
    log(`[resident-advisor] ${events.length} NYC events from ${byId.size} listed (${total} listings)`);

    let result = { new: 0, updated: 0, errors: [] };
    if (events.length > 0) {
      result = await upsertEvents(events);
      errors.push(...result.errors);
    }
    log(`[resident-advisor] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);

    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   events.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[resident-advisor] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, { sourceName: SOURCE_KEY, eventsFound: events.length, errors });
    throw err;
  }
}
