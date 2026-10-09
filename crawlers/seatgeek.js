/**
 * SeatGeek Platform API Crawler (dormant stub)
 *
 * Requires SEATGEEK_CLIENT_ID (partner program approval needed).
 * Without the key this crawl is a no-op — it logs and returns cleanly.
 * When the key is present it queries the SeatGeek API with an NYC geo filter
 * and maps results into the event schema.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { resolveArea } from '../lib/nyc-area.js';

const SOURCE = 'SeatGeek';
const API_BASE = 'https://api.seatgeek.com/2';

// NYC rough bounding box for geo filter
const NYC_LAT  = 40.7128;
const NYC_LNG  = -74.0060;
const RADIUS_MI = 25;

export function mapEvent(item) {
  const title = item.title?.trim();
  if (!title) return null;

  const performers = (item.performers ?? []).map(p => p.name).filter(Boolean);
  const venue = item.venue ?? {};
  // datetime_local is NYC wall-clock; datetime_utc has no offset suffix, so mark it as UTC.
  const dt = item.datetime_local
    ?? (item.datetime_utc ? item.datetime_utc.replace(/Z?$/, 'Z') : null);

  const address = [venue.address, venue.extended_address].filter(Boolean).join(', ') || null;
  const lat = venue.location?.lat ?? null;
  const lng = venue.location?.lon ?? null;

  return {
    id:          generateEventId(item.url ?? `seatgeek-${item.id}`, title),
    source:      SOURCE,
    sourceUrl:   item.url ?? null,
    title,
    description: performers.length ? `Performers: ${performers.join(', ')}` : '',
    startDate:   dt,
    endDate:     null,
    time:        null,
    location: {
      name:    venue.name ?? null,
      address,
      city:    venue.city ?? 'New York',
      lat,
      lng,
    },
    price:       {
      isFree:   false,
      min:      item.stats?.lowest_price   ?? null,
      max:      item.stats?.highest_price  ?? null,
      currency: 'USD',
    },
    categories:  [item.type ?? 'Concert'],
    tags:        ['seatgeek', 'ticketed'],
    organizer:   null,
    attendance:  item.stats?.listing_count ?? null,
    ticketUrl:   item.url ?? null,
    images:      item.performers?.[0]?.image ? [item.performers[0].image] : [],
    rawText:     null,
    ...resolveArea({ name: venue.name, address, lat, lng }),
  };
}

/**
 * Fetch the NYC event page for a client id.
 * @param {string} clientId
 * @param {typeof fetch} [fetchImpl] injectable for tests
 */
export async function fetchEvents(clientId, fetchImpl = fetch) {
  const params = new URLSearchParams({
    client_id: clientId,
    lat:        String(NYC_LAT),
    lon:        String(NYC_LNG),
    range:      `${RADIUS_MI}mi`,
    per_page:   '100',
    sort:       'datetime_utc.asc',
  });

  const url = `${API_BASE}/events?${params}`;
  // Never echo the client id: this URL is printed on every nightly run.
  const logParams = new URLSearchParams(params);
  logParams.set('client_id', 'SEATGEEK_CLIENT_ID');
  log(`[seatgeek] Fetching: ${API_BASE}/events?${logParams}`);

  const res = await fetchImpl(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'fomo3-events-bot/1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`SeatGeek API HTTP ${res.status}`);
  const data = await res.json();
  return data.events ?? [];
}

export async function crawl() {
  const clientId = process.env.SEATGEEK_CLIENT_ID;
  if (!clientId) {
    log('[seatgeek] SEATGEEK_CLIENT_ID not set — skipping (dormant stub)');
    return;
  }

  log(`[seatgeek] Starting crawl`);
  const runId = await startCrawlRun('seatgeek');
  const errors = [];

  try {
    const items = await fetchEvents(clientId);
    log(`[seatgeek] ${items.length} events from API`);

    const events = items.map(mapEvent).filter(Boolean);
    log(`[seatgeek] ${events.length} mapped`);

    const result = await upsertEvents(events);
    errors.push(...result.errors);

    log(`[seatgeek] Done — ${result.new} new, ${result.updated} updated`);

    await finishCrawlRun(runId, {
      sourceName:    'seatgeek',
      eventsFound:   events.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[seatgeek] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, { sourceName: 'seatgeek', eventsFound: 0, eventsNew: 0, eventsUpdated: 0, errors });
    throw err;
  }
}
