/**
 * NYC Parks Crawler
 * Primary:  NYC Open Data w3wp-dpdi (same "Upcoming 14 Days" feed, as JSON)
 * Fallback: https://www.nycgovparks.org/xml/events_300_rss.xml
 * The RSS host answers GitHub Actions runners with HTTP 405, so Socrata goes first.
 */
import { parseStringPromise } from 'xml2js';
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';

const RSS_URL = 'https://www.nycgovparks.org/xml/events_300_rss.xml';
const SOCRATA_URL = 'https://data.cityofnewyork.us/resource/w3wp-dpdi.json';
const SOURCE  = 'NYC Parks';

function parsePriceText(text) {
  if (!text) return { isFree: null, min: null, max: null, currency: 'USD' };
  const lower = text.toLowerCase();
  if (lower.includes('free') || lower === '0' || lower === '$0') return { isFree: true, min: 0, max: 0, currency: 'USD' };
  const match = text.match(/\$(\d+(?:\.\d{2})?)/);
  if (match) return { isFree: false, min: parseFloat(match[1]), max: parseFloat(match[1]), currency: 'USD' };
  return { isFree: null, min: null, max: null, currency: 'USD' };
}

function parseBoroughFromParkName(parkName) {
  if (!parkName) return null;
  const n = parkName.toLowerCase();
  if (n.includes('brooklyn')) return 'Brooklyn';
  if (n.includes('queens'))   return 'Queens';
  if (n.includes('bronx'))    return 'The Bronx';
  if (n.includes('staten'))   return 'Staten Island';
  return 'Manhattan'; // default for NYC Parks
}

// First letter of a Parks property id (e.g. 'B008') is the borough
const PARK_ID_BOROUGH = { M: 'Manhattan', B: 'Brooklyn', Q: 'Queens', X: 'The Bronx', R: 'Staten Island' };

function boroughFromParkIds(parkIds) {
  return PARK_ID_BOROUGH[parkIds?.trim()?.[0]?.toUpperCase()] ?? null;
}

function splitCategories(raw) {
  return (raw ?? '').split('|').map(c => c.trim()).filter(Boolean);
}

function parseCoords(coords) {
  const [lat, lng] = coords ? coords.split(',').map(v => parseFloat(v.trim())) : [null, null];
  return { lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null };
}

/** '2026-09-30T08:00:00.000' (NYC wall clock) → '8:00 AM', without timezone conversion. */
export function wallClockLabel(ts) {
  const m = typeof ts === 'string' && ts.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1];
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** Map one w3wp-dpdi row to the shared event shape (ids match the RSS path). */
export function mapSocrataRow(row) {
  const title = row.title?.trim();
  const link  = row.link?.url?.trim();
  if (!title || !link || !row.starttime) return null;

  const parkNames = row.parknames?.trim() || null;
  const location  = row.location?.trim() || null;
  const categories = splitCategories(row.categories);
  const startLabel = wallClockLabel(row.starttime);
  const endLabel   = wallClockLabel(row.endtime);

  return {
    id:          generateEventId(link, title),
    source:      SOURCE,
    sourceUrl:   link,
    title,
    description:  row.description?.trim() ?? '',
    startDate:    row.starttime,  // offset-less NYC wall clock; upsertEvent normalizes
    endDate:      row.endtime ?? null,
    time:         startLabel && endLabel ? `${startLabel}–${endLabel}` : startLabel,
    location: {
      name:    parkNames ?? location ?? 'NYC Park',
      address: location,
      city:    'New York',
      ...parseCoords(row.coordinates),
    },
    price:        { isFree: true, min: 0, max: 0, currency: 'USD' },
    categories:   categories.length ? categories : ['Parks & Recreation'],
    tags:         ['parks', 'outdoor'],
    organizer:    'NYC Parks',
    attendance:   null,
    ticketUrl:    row.registration_url?.url ?? null,
    images:       row.image?.url ? [row.image.url] : [],
    rawText:      null,
    neighborhood: parkNames,
    borough:      boroughFromParkIds(row.parkids) ?? parseBoroughFromParkName(parkNames),
  };
}

async function fetchSocrataEvents() {
  const params = new URLSearchParams({ '$limit': '5000', '$order': 'starttime ASC' });
  const token = process.env.NYC_OPENDATA_APP_TOKEN;
  const res = await fetch(`${SOCRATA_URL}?${params}`, {
    headers: { 'Accept': 'application/json', ...(token ? { 'X-App-Token': token } : {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`w3wp-dpdi HTTP ${res.status}`);
  const rows = await res.json();
  log(`[nyc-parks] Found ${rows.length} rows in Open Data feed`);
  return rows.map(mapSocrataRow).filter(Boolean);
}

async function fetchRssEvents() {
  const res = await fetch(RSS_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();

  const parsed = await parseStringPromise(xml, { explicitArray: true });
  const items  = parsed?.rss?.channel?.[0]?.item ?? [];
  log(`[nyc-parks] Found ${items.length} items in RSS feed`);
  return items.map(parseItem).filter(Boolean);
}

export function parseItem(item) {
  try {
    const title       = item.title?.[0]?.trim();
    const link        = item.link?.[0]?.trim();
    const description = item.description?.[0]?.trim();

    if (!title || !link) return null;

    // event:* fields sit at the top level of item (not nested under event:event)
    const startDate = item['event:startdate']?.[0] ?? null;
    const endDate   = item['event:enddate']?.[0]   ?? null;
    const startTime = item['event:starttime']?.[0] ?? null;
    const endTime   = item['event:endtime']?.[0]   ?? null;
    const location  = item['event:location']?.[0]  ?? null;
    const parkNames = item['event:parknames']?.[0] ?? null;
    const parkIds   = item['event:parkids']?.[0]   ?? null;
    const coords    = item['event:coordinates']?.[0];
    const imageUrl  = item['event:image']?.[0]     ?? null;
    const categories = splitCategories(item['event:categories']?.[0]);

    const event = {
      id:          generateEventId(link, title),
      source:      SOURCE,
      sourceUrl:   link,
      title,
      description:  description ?? '',
      startDate,  // raw feed value; upsertEvent normalizes to the NYC date
      endDate,
      time:         startTime && endTime ? `${startTime}–${endTime}` : startTime,
      location: {
        name:    parkNames ?? location ?? 'NYC Park',
        address: location ?? null,
        city:    'New York',
        ...parseCoords(coords),
      },
      price:        { isFree: true, min: 0, max: 0, currency: 'USD' }, // Parks events are free; no admission field in feed
      categories:   categories.length ? categories : ['Parks & Recreation'],
      tags:         ['parks', 'outdoor'],
      organizer:    'NYC Parks',
      attendance:   null,
      ticketUrl:    null,
      images:       imageUrl ? [imageUrl] : [],  // imageUrl may be empty string — falsy check handles it
      rawText:      null,
      neighborhood: parkNames ?? null,
      borough:      boroughFromParkIds(parkIds) ?? parseBoroughFromParkName(parkNames),
    };

    return event;
  } catch (err) {
    return null;
  }
}

export async function crawl() {
  log(`[nyc-parks] Starting crawl`);
  const runId = await startCrawlRun('nyc-parks');
  const errors = [];

  try {
    let events = [];
    try {
      events = await fetchSocrataEvents();
    } catch (err) {
      logError('[nyc-parks] Open Data fetch failed, falling back to RSS', err);
    }
    if (events.length === 0) events = await fetchRssEvents();
    log(`[nyc-parks] Parsed ${events.length} valid events`);

    const result = await upsertEvents(events);
    errors.push(...result.errors);

    log(`[nyc-parks] Done — ${result.new} new, ${result.updated} updated, ${result.errors.length} errors`);

    await finishCrawlRun(runId, {
      sourceName:    'nyc-parks',
      eventsFound:   events.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[nyc-parks] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, { sourceName: 'nyc-parks', eventsFound: 0, eventsNew: 0, eventsUpdated: 0, errors });
    throw err;
  }
}
