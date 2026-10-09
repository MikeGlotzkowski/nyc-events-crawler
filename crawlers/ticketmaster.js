/**
 * Ticketmaster Discovery API crawler (A1).
 *
 * Queries the Discovery v2 events endpoint for NYC and maps results into the
 * shared event schema. Requires TICKETMASTER_API_KEY — without it the crawl is a
 * clean no-op (same shape as seatgeek.js).
 *
 * NYC filter: latlong + 25-mile radius centred on Manhattan, plus stateCode=NY.
 * Chosen over `city=New York` because TM labels many real NYC venues by their
 * own city ("Brooklyn", "Bronx", "New York City") — and also a few out-of-town
 * tags ("Belmont Park"). Probed 2026-10-09 over the same week: `city=New York`
 * returned 942 events, all labelled "New York"; latlong+radius returned 1,284,
 * including 25 "Brooklyn", 5 "Bronx", 15 "New York City" (with a handful of
 * non-NYC stragglers that resolveArea + the canonical reconcile step absorb).
 * We therefore bias toward recall and let the shared area resolver decide the
 * borough.
 *
 * Paging: the API caps deep paging at size*page < 1000, so a naive deep crawl
 * cannot reach a busy window. Instead the forward window is chunked by date
 * (CHUNK_DAYS) and each chunk is paged only a few times, keeping size*page <= 800.
 * Measured 2026-10-09: 3-day chunks top out at 692 events (the 1,000 cap), while
 * 7-day chunks already hit 1,361 — so 3 days is the smallest safe chunk.
 *
 * Courtesy: the docs ask for <=5 req/s and <=5,000 calls/day; every request is
 * spaced REQUEST_DELAY_MS apart, and a 429 backs off (honouring Rate-Limit-Reset)
 * instead of throwing.
 *
 * Attribution: TM's terms require crediting Ticketmaster and linking to their
 * event URL. Every mapped event carries the Ticketmaster source name, links to
 * the TM/venue seller URL, and keeps the attribution notice in rawText.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { resolveArea } from '../lib/nyc-area.js';

export const SOURCE     = 'Ticketmaster';
const SOURCE_KEY        = 'ticketmaster';
const API_BASE          = 'https://app.ticketmaster.com/discovery/v2/events.json';
const UA                = 'fomo3-events-bot/1.0 (+https://github.com/fomo3)';

// NYC focus
export const NYC_LAT    = 40.7128;
export const NYC_LNG    = -74.0060;
export const RADIUS_MI  = 25;

// Window + paging
export const WINDOW_DAYS = 60;
export const CHUNK_DAYS  = 3;   // measured max ~692 events/window — safely under the cap
export const SIZE        = 200; // API max page size
// size*page < 1000 => pages 0..3 (max size*page = 800). Never request page >= 5.
export const MAX_PAGES_PER_WINDOW = Math.floor(1000 / SIZE) - 1; // 4
export const REQUEST_DELAY_MS = 200; // <= 5 req/s

// Rate-limit backoff
export const MIN_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 15000;
const MAX_RETRIES = 3;

export const ATTRIBUTION =
  'Event data provided by Ticketmaster. Ticket links point to Ticketmaster or the venue\'s official seller.';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

/** ISO-8601 to whole seconds, Z-suffixed — Ticketmaster rejects millisecond precision. */
export function isoSeconds(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The exact Discovery request URL for one page of one date window. */
export function buildPageUrl({ apiKey, startDateTime, endDateTime, page, size = SIZE }) {
  const params = new URLSearchParams({
    apikey: apiKey,
    latlong: `${NYC_LAT.toFixed(4)},${NYC_LNG.toFixed(4)}`,
    radius: String(RADIUS_MI),
    unit: 'miles',
    stateCode: 'NY',
    size: String(size),
    sort: 'date,asc',
    startDateTime,
    endDateTime,
    page: String(page),
  });
  return `${API_BASE}?${params}`;
}

/** Split the forward window into [start, end) chunks of at most chunkDays. */
export function windowRanges(now = new Date(), windowDays = WINDOW_DAYS, chunkDays = CHUNK_DAYS) {
  const out = [];
  const end = new Date(now.getTime() + windowDays * 86400000);
  for (let s = new Date(now); s < end; ) {
    const e = new Date(Math.min(s.getTime() + chunkDays * 86400000, end.getTime()));
    out.push({ start: new Date(s), end: e });
    s = e;
  }
  return out;
}

/** Backoff for a failed attempt: Rate-Limit-Reset when the API sent it, else exponential. */
export function retryDelayMs(res, attempt = 1) {
  const reset = Number(res?.headers?.get?.('Rate-Limit-Reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const wait = reset * 1000 - Date.now();
    return Math.min(Math.max(wait, 0), MAX_BACKOFF_MS);
  }
  return Math.min(MIN_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/** One page, retrying a 429 (or a transient network error) with backoff instead of throwing. */
async function fetchPage(url, fetchImpl, sleepImpl) {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      if (attempt > MAX_RETRIES) throw err;
      await sleepImpl(retryDelayMs(null, attempt));
      continue;
    }
    if (res.status === 429 && attempt <= MAX_RETRIES) {
      const delay = retryDelayMs(res, attempt);
      log(`[ticketmaster] 429 rate-limited — backing off ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`);
      await sleepImpl(delay);
      continue;
    }
    if (!res.ok) throw new Error(`Ticketmaster API HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('Ticketmaster API: retries exhausted');
}

/**
 * Fetch every event in one date window, paging within the deep-paging cap.
 * @returns {Promise<object[]>} raw Discovery event objects
 */
export async function fetchWindow({ apiKey, startDateTime, endDateTime, fetchImpl = fetch, sleepImpl = sleep, size = SIZE }) {
  const events = [];
  for (let page = 0; page < MAX_PAGES_PER_WINDOW; page++) {
    const data = await fetchPage(buildPageUrl({ apiKey, startDateTime, endDateTime, page, size }), fetchImpl, sleepImpl);
    const batch = data?._embedded?.events ?? [];
    events.push(...batch);
    const totalPages = data?.page?.totalPages ?? 0;
    if (page + 1 >= totalPages) break;
  }
  return events;
}

// ── Mapping ──────────────────────────────────────────────────────

/** Best image: largest 16_9, falling back to the largest of any ratio. */
export function pickImage(images) {
  const list = (images ?? []).filter((i) => i && typeof i.url === 'string' && i.url);
  if (list.length === 0) return null;
  const byWidth = (a, b) => (b.width ?? 0) - (a.width ?? 0);
  const wide = list.filter((i) => i.ratio === '16_9').sort(byWidth);
  return (wide[0] ?? [...list].sort(byWidth)[0]).url;
}

/** TM splits the blurb across info + pleaseNote; join the non-empty parts. */
export function buildDescription(item = {}) {
  return [item.info, item.pleaseNote]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
}

/** Segment + genre, deduped; TM's literal "Undefined" is dropped. */
function mapCategories(classifications) {
  const out = [];
  for (const c of [].concat(classifications ?? [])) {
    for (const v of [c?.segment?.name, c?.genre?.name]) {
      if (typeof v !== 'string') continue;
      const name = v.trim();
      if (!name || /^undefined$/i.test(name) || out.includes(name)) continue;
      out.push(name);
    }
  }
  return out;
}

/** priceRanges[0] → { isFree, min, max, currency }. Missing range leaves it unknown. */
function mapPrice(priceRanges) {
  const r = Array.isArray(priceRanges) ? priceRanges[0] : null;
  if (!r || r.min == null) return { isFree: false, min: null, max: null, currency: 'USD' };
  const min = num(r.min);
  const max = num(r.max ?? r.min);
  return { isFree: min === 0 && (max === 0 || max == null), min, max, currency: r.currency ?? 'USD' };
}

export function mapEvent(item) {
  const title = typeof item?.name === 'string' ? item.name.trim() : '';
  if (!title) return null;

  const start = item.dates?.start ?? {};
  const startDate = start.dateTime ?? start.localDate ?? null;
  if (!startDate || Number.isNaN(Date.parse(startDate))) return null;
  const endDate = item.dates?.end?.dateTime ?? null;

  const venue = item._embedded?.venues?.[0] ?? {};
  const lat = num(venue.location?.latitude);
  const lng = num(venue.location?.longitude);
  const cityState = [venue.city?.name, venue.state?.stateCode ?? 'NY', venue.postalCode].filter(Boolean).join(' ');
  const address = [venue.address?.line1?.trim(), cityState].filter(Boolean).join(', ') || null;

  const url = item.url ?? null;

  return {
    id:          generateEventId(url ?? `ticketmaster-${item.id}`, title),
    source:      SOURCE,
    sourceUrl:   url,
    title,
    description: buildDescription(item),
    startDate,
    endDate,
    time:        null,
    location: {
      name:    venue.name ?? null,
      address,
      city:    'New York',
      lat,
      lng,
    },
    price:       mapPrice(item.priceRanges),
    categories:  mapCategories(item.classifications),
    tags:        ['ticketmaster'],
    organizer:   SOURCE,
    attendance:  null,
    ticketUrl:   url,
    images:      [pickImage(item.images)].filter(Boolean),
    rawText:     ATTRIBUTION,
    ...resolveArea({ name: venue.name, address, lat, lng }),
  };
}

// ── Main entry point ─────────────────────────────────────────────

export async function crawl() {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) {
    log('[ticketmaster] TICKETMASTER_API_KEY not set — skipping (no API key)');
    return;
  }

  log('[ticketmaster] Starting crawl');
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];

  try {
    const raw = [];
    for (const range of windowRanges(new Date())) {
      const startDateTime = isoSeconds(range.start);
      const endDateTime = isoSeconds(range.end);
      try {
        const batch = await fetchWindow({ apiKey, startDateTime, endDateTime });
        log(`[ticketmaster] ${startDateTime} → ${endDateTime}: ${batch.length} events`);
        raw.push(...batch);
      } catch (err) {
        logError(`[ticketmaster]   window ${startDateTime} failed`, err);
        errors.push(`${startDateTime}: ${err.message}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }

    const events = raw.map(mapEvent).filter(Boolean);
    log(`[ticketmaster] ${raw.length} raw, ${events.length} mapped`);

    const result = await upsertEvents(events);
    errors.push(...result.errors);
    log(`[ticketmaster] Done — ${result.new} new, ${result.updated} updated`);

    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   events.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[ticketmaster] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, { sourceName: SOURCE_KEY, eventsFound: 0, eventsNew: 0, eventsUpdated: 0, errors });
    throw err;
  }
}
