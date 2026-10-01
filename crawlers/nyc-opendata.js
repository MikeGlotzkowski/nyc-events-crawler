/**
 * NYC Open Data (Socrata) Crawler
 * Keyless by default — if NYC_OPENDATA_APP_TOKEN is set, it's sent as X-App-Token.
 *
 * Dataset: tvpp-9vvx — NYC Permitted Event Information (citywide, ~60-day forward window).
 * NYC Parks public events (w3wp-dpdi) are crawled by crawlers/nyc-parks.js.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';

const SOURCE_PERMITTED = 'NYC Open Data — Permitted Events';

const BASE = 'https://data.cityofnewyork.us/resource';

// Public-facing event types in tvpp-9vvx. Everything else is dropped: youth/adult sports
// permits, production shoots, sidewalk sales, religious services, clean-ups, load-ins, and
// 'Special Event' — those are all Parks Department permits, overwhelmingly private picnics,
// parties and lawn closures; public Parks events come from crawlers/nyc-parks.js instead.
export const PERMITTED_TYPE_ALLOWLIST = new Set([
  'Farmers Market',
  'Street Event',
  'Block Party',
  'Parade',
  'Plaza Event',
  'Plaza Partner Event',
  'Open Street Partner Event',
  'Athletic Race / Tour',
  'Single Block Festival',
  'Street Festival',
  'Health Fair',
]);

function appTokenHeader() {
  const token = process.env.NYC_OPENDATA_APP_TOKEN;
  return token ? { 'X-App-Token': token } : {};
}

const nycFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Date → 'YYYY-MM-DDTHH:MM:SS' NYC wall clock (Socrata floating timestamps reject a 'Z'). */
export function toNycFloating(date) {
  const p = Object.fromEntries(nycFmt.formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export function buildPermittedWhere(now = new Date(), days = 60) {
  const end = new Date(now.getTime() + days * 86400000);
  const types = [...PERMITTED_TYPE_ALLOWLIST].map(t => `'${t.replace(/'/g, "''")}'`).join(', ');
  return `start_date_time >= '${toNycFloating(now)}' AND start_date_time <= '${toNycFloating(end)}' AND event_type in(${types})`;
}

// Private or non-event permits that slip through the type allowlist
const TITLE_DENYLIST = /\b(wedding|closure|no amplified sound|funeral|memorial service)\b/i;

// ── Permitted Events (tvpp-9vvx) ─────────────────────────────────

export function mapPermittedEvent(row) {
  const title = row.event_name?.trim();
  if (!title || TITLE_DENYLIST.test(title)) return null;

  const eventType = (row.event_type ?? '').trim();
  if (!PERMITTED_TYPE_ALLOWLIST.has(eventType)) return null;

  // Socrata floating timestamps (no offset) are NYC wall-clock; upsertEvent interprets them.
  const startDate = row.start_date_time ?? null;
  const endDate   = row.end_date_time   ?? null;
  if (!startDate) return null;

  const borough = normalizeBoroughName(row.event_borough ?? null);
  const address = row.event_location?.trim() || null;

  return {
    id:          generateEventId(`nyc-opendata-permitted-${row.event_id ?? ''}`, title),
    source:      SOURCE_PERMITTED,
    sourceUrl:   'https://data.cityofnewyork.us/City-Government/NYC-Permitted-Event-Information/tvpp-9vvx',
    title,
    description: row.event_agency ?? '',
    startDate,
    endDate,
    time:        null,
    location: {
      name:    address ?? borough ?? 'New York City',
      address,
      city:    'New York',
      lat:     null,
      lng:     null,
    },
    price:       { isFree: true, min: 0, max: 0, currency: 'USD' },
    categories:  [eventType],
    tags:        ['permitted', 'citywide'],
    organizer:   null,
    attendance:  null,
    ticketUrl:   null,
    images:      [],
    rawText:     null,
    neighborhood: null,
    borough,
  };
}

/** The dataset repeats an event_id per permitted location/time slot; keep the first (earliest). */
export function dedupeByEventId(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const key = r.event_id ?? `${r.event_name}|${r.start_date_time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchPermittedEvents() {
  const params = new URLSearchParams({
    '$limit':  '5000',
    '$where':  buildPermittedWhere(),
    '$order':  'start_date_time ASC',
  });

  const url = `${BASE}/tvpp-9vvx.json?${params}`;
  log(`[nyc-opendata] Fetching permitted events: ${url}`);

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', ...appTokenHeader() },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`tvpp-9vvx HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────────────

function normalizeBoroughName(raw) {
  if (!raw) return null;
  const b = raw.trim().toUpperCase();
  if (b === 'MN' || b === 'MANHATTAN')    return 'Manhattan';
  if (b === 'BK' || b === 'BROOKLYN')     return 'Brooklyn';
  if (b === 'QN' || b === 'QUEENS')       return 'Queens';
  if (b === 'BX' || b === 'BRONX' || b === 'THE BRONX') return 'The Bronx';
  if (b === 'SI' || b === 'STATEN ISLAND') return 'Staten Island';
  // Title-case passthrough
  const parts = raw.trim().toLowerCase().split(/\s+/);
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// ── Main entry point ──────────────────────────────────────────────

export async function crawl() {
  log(`[nyc-opendata] Starting crawl`);
  const runId = await startCrawlRun('nyc-opendata');
  const errors = [];
  let totalFound = 0, totalNew = 0, totalUpdated = 0;

  try {
    const rows = dedupeByEventId(await fetchPermittedEvents());
    log(`[nyc-opendata] Permitted events: ${rows.length} rows`);
    const events = rows.map(mapPermittedEvent).filter(Boolean);
    log(`[nyc-opendata] Permitted events: ${events.length} mapped`);

    if (events.length > 0) {
      const result = await upsertEvents(events);
      totalFound += events.length;
      totalNew   += result.new;
      totalUpdated += result.updated;
      errors.push(...result.errors);
    }
  } catch (err) {
    logError('[nyc-opendata] Permitted events fetch failed', err);
    errors.push(`permitted-events: ${err.message}`);
  }

  log(`[nyc-opendata] Done — ${totalNew} new, ${totalUpdated} updated, ${errors.length} errors`);

  await finishCrawlRun(runId, {
    sourceName:    'nyc-opendata',
    eventsFound:   totalFound,
    eventsNew:     totalNew,
    eventsUpdated: totalUpdated,
    errors,
  });
}
