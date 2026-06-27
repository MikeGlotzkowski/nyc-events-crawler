/**
 * NYC Open Data (Socrata) Crawler
 * Keyless by default — if NYC_OPENDATA_APP_TOKEN is set, it's sent as X-App-Token.
 *
 * Datasets:
 *   tvpp-9vvx — NYC Permitted Event Information (citywide, ~60-day forward window)
 *   w3wp-dpdi — NYC Parks Public Events (14-day upcoming window)
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';

const SOURCE_PERMITTED = 'NYC Open Data — Permitted Events';
const SOURCE_PARKS     = 'NYC Open Data — Parks Events';

const BASE = 'https://data.cityofnewyork.us/resource';

// Event types we want from the permitted-events dataset (drop film/production-shoot noise)
const PERMITTED_TYPE_ALLOWLIST = new Set([
  'Street Festival',
  'Special Event',
  'Farmers Market',
  'Fair/Festival',
  'Block Party',
  'Parade/March',
  'Parade',
  'Concert/Performance',
  'Athletic Competition',
  'Walk/Run/Bike Tour',
  'Community Event',
  'Street Fair',
]);

function appTokenHeader() {
  const token = process.env.NYC_OPENDATA_APP_TOKEN;
  return token ? { 'X-App-Token': token } : {};
}

function forwardWindowDates(days = 60) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + days);
  return { from: now.toISOString(), to: end.toISOString() };
}

// ── Permitted Events (tvpp-9vvx) ─────────────────────────────────

function mapPermittedEvent(row) {
  const title = row.event_name?.trim();
  if (!title) return null;

  // Filter by event type
  const eventType = (row.event_type ?? '').trim();
  if (eventType && !PERMITTED_TYPE_ALLOWLIST.has(eventType)) return null;

  const startDate = row.start_date_time ? new Date(row.start_date_time).toISOString() : null;
  const endDate   = row.end_date_time   ? new Date(row.end_date_time).toISOString()   : null;
  if (!startDate) return null;

  const borough = normalizeBoroughName(row.event_borough ?? row.borough ?? null);
  const address = [row.street_address, row.between_streets].filter(Boolean).join(' between ') || null;

  return {
    id:          generateEventId(`nyc-opendata-permitted-${row.event_id ?? row.eventtimeid ?? ''}`, title),
    source:      SOURCE_PERMITTED,
    sourceUrl:   'https://data.cityofnewyork.us/City-Government/NYC-Permitted-Event-Information/tvpp-9vvx',
    title,
    description: row.event_agency ?? '',
    startDate,
    endDate,
    time:        null,
    location: {
      name:    address ?? borough ?? 'New York City',
      address: address,
      city:    'New York',
      lat:     null,
      lng:     null,
    },
    price:       { isFree: true, min: 0, max: 0, currency: 'USD' },
    categories:  [eventType || 'Special Event'],
    tags:        ['permitted', 'citywide'],
    organizer:   row.event_contact_name?.trim() ?? null,
    attendance:  row.attendees ? Number(row.attendees) : null,
    ticketUrl:   null,
    images:      [],
    rawText:     null,
    neighborhood: null,
    borough,
  };
}

async function fetchPermittedEvents() {
  const { from, to } = forwardWindowDates(60);
  const params = new URLSearchParams({
    '$limit':  '1000',
    '$where':  `start_date_time >= '${from}' AND start_date_time <= '${to}'`,
    '$order':  'start_date_time ASC',
  });

  const url = `${BASE}/tvpp-9vvx.json?${params}`;
  log(`[nyc-opendata] Fetching permitted events: ${url}`);

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', ...appTokenHeader() },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`tvpp-9vvx HTTP ${res.status}`);
  return res.json();
}

// ── Parks Public Events (w3wp-dpdi) ──────────────────────────────

function mapParksEvent(row) {
  const title = (row.name ?? row.event_name ?? '').trim();
  if (!title) return null;

  const startDate = row.startdate ? new Date(row.startdate).toISOString()
                  : row.start_date ? new Date(row.start_date).toISOString()
                  : null;
  const endDate   = row.enddate   ? new Date(row.enddate).toISOString()
                  : row.end_date  ? new Date(row.end_date).toISOString()
                  : null;

  const parkName = (row.park ?? row.park_name ?? row.location ?? '').trim() || null;
  const borough  = normalizeBoroughName(row.borough ?? null);

  const url = (row.url ?? row.link ?? '').trim() || null;
  const id = url
    ? generateEventId(url, title)
    : generateEventId(`nyc-parks-opendata-${parkName ?? ''}-${startDate ?? ''}`, title);

  return {
    id,
    source:      SOURCE_PARKS,
    sourceUrl:   url ?? 'https://data.cityofnewyork.us/Recreation/NYC-Parks-Public-Events-Upcoming-14-Days/w3wp-dpdi',
    title,
    description: (row.description ?? row.event_description ?? '').trim(),
    startDate,
    endDate,
    time:        (row.time ?? row.event_time ?? null)?.trim() ?? null,
    location: {
      name:    parkName ?? borough ?? 'NYC Park',
      address: row.address?.trim() ?? null,
      city:    'New York',
      lat:     row.latitude  ? parseFloat(row.latitude)  : null,
      lng:     row.longitude ? parseFloat(row.longitude) : null,
    },
    price:       { isFree: true, min: 0, max: 0, currency: 'USD' },
    categories:  [(row.category ?? row.event_type ?? 'Parks & Recreation').trim()],
    tags:        ['parks', 'outdoor', 'free'],
    organizer:   'NYC Parks',
    attendance:  null,
    ticketUrl:   url,
    images:      [],
    rawText:     null,
    neighborhood: parkName,
    borough,
  };
}

async function fetchParksEvents() {
  const { from } = forwardWindowDates(0); // dataset already scoped to 14-day window
  const params = new URLSearchParams({
    '$limit': '500',
    '$order': 'startdate ASC',
  });

  const url = `${BASE}/w3wp-dpdi.json?${params}`;
  log(`[nyc-opendata] Fetching parks events: ${url}`);

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', ...appTokenHeader() },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`w3wp-dpdi HTTP ${res.status}`);
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

  // Dataset 1: Permitted Events
  try {
    const rows = await fetchPermittedEvents();
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

  // Dataset 2: Parks Public Events
  try {
    const rows = await fetchParksEvents();
    log(`[nyc-opendata] Parks events: ${rows.length} rows`);
    const events = rows.map(mapParksEvent).filter(Boolean);
    log(`[nyc-opendata] Parks events: ${events.length} mapped`);

    if (events.length > 0) {
      const result = await upsertEvents(events);
      totalFound   += events.length;
      totalNew     += result.new;
      totalUpdated += result.updated;
      errors.push(...result.errors);
    }
  } catch (err) {
    logError('[nyc-opendata] Parks events fetch failed', err);
    errors.push(`parks-events: ${err.message}`);
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
