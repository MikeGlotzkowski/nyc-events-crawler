/**
 * Brooklyn Public Library Events Crawler
 * discover.bklynlibrary.org search API — the endpoint answers
 * {"error":"access denied"} unless the request carries the site's own Referer.
 * Results come back sorted by start date ascending, 20 per page.
 * No browser required — pure HTTP.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';

const SOURCE_KEY = 'brooklyn-library';
const SOURCE     = 'Brooklyn Public Library';
const ORGANIZER  = 'Brooklyn Public Library';
const BOROUGH    = 'Brooklyn';
const API_URL    = 'https://discover.bklynlibrary.org/api/search/v2.php?event=true&pagination=';
const EVENT_URL  = 'https://www.bklynlibrary.org/node/';
const TZ         = 'America/New_York';
const HORIZON_DAYS  = 14;
const MAX_PAGES     = 50;
const PAGE_DELAY_MS = 300;

const HEADERS = {
  // The API rejects requests without this Referer
  'Referer': 'https://discover.bklynlibrary.org/?event=true',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Drop-in service sessions (resume help, tax prep, ESOL, ...) are recurring drop-ins, not events
const SERVICE_SESSION_RE = /\b(walk-in|drop[- ]in (resume|career|tech|help)|office hours|resume|career help|tax (prep|help)|social work|benefits|esol|esl\b|english conversation|citizenship|job search|computer help|tech help)\b/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function decodeEntities(text) {
  return text.replace(/&(#\d+|[a-z]+);/gi, (m, name) => {
    const key = name.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)));
    return m;
  });
}

function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** ISO instant string → ms, or null when missing/unparseable. */
function toInstant(value) {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : ms;
}

/** ISO instant → '6:00 PM' in NYC wall-clock time. */
function formatClock(value) {
  const ms = toInstant(value);
  if (ms === null) return null;
  return clockFmt.format(new Date(ms)).replace(/[\u202f\u00a0]/g, ' ').trim();
}

/** '10:00 AM' / '10:00 AM–5:00 PM' / null when either end is unknown. */
export function formatTimeRange(startIso, endIso) {
  const start = formatClock(startIso);
  if (!start) return null;
  const end = formatClock(endIso);
  return end && end !== start ? `${start}–${end}` : start;
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(v => (typeof v === 'string' ? v.trim() : v)).filter(Boolean);
}

/** One search page → its event docs (every group holds a single doc). */
export function extractDocs(data) {
  const groups = data?.grouped?.ss_grouping?.groups;
  if (!Array.isArray(groups)) return [];
  return groups.map(g => g?.doclist?.docs?.[0]).filter(Boolean);
}

/** Cancelled, virtual and recurring drop-in service sessions are not events. */
export function shouldSkip(doc) {
  if (!doc) return true;
  if (doc.is_event_canceled === 1) return true;
  if (doc.is_virtual === 1) return true;
  return SERVICE_SESSION_RE.test(stripHtml(doc.ts_title ?? ''));
}

/** Map one search doc to the shared event shape, or null when it is not an event. */
export function mapDoc(doc) {
  if (shouldSkip(doc)) return null;

  const title  = stripHtml(doc.ts_title ?? '');
  const nodeId = doc.ss_item_id == null ? '' : String(doc.ss_item_id).trim();
  const startMs = toInstant(doc.ds_event_start_date);
  if (!title || !nodeId || startMs === null) return null;

  const endMs = toInstant(doc.ds_event_end_date);
  const url   = `${EVENT_URL}${nodeId}`;
  const branch = stripHtml(doc.ss_event_location ?? '') || null;

  const tags = ['library'];
  const age = typeof doc.ts_event_age === 'string' ? doc.ts_event_age.trim() : '';
  if (age) tags.push(age);
  if (doc.is_event_registration === 1) tags.push('registration-required');

  return {
    // One node repeats with a new date per session, so the start date is part of the id
    id:          generateEventId(`${url}#${doc.ds_event_start_date}`, title),
    source:      SOURCE,
    sourceUrl:   url,
    title,
    description: stripHtml(doc.ts_body ?? ''),
    startDate:   new Date(startMs).toISOString(),
    endDate:     endMs === null ? null : new Date(endMs).toISOString(),
    time:        formatTimeRange(doc.ds_event_start_date, doc.ds_event_end_date),
    location: {
      name:    branch ?? 'Brooklyn Public Library',
      address: null,
      city:    'New York',
      lat:     null,
      lng:     null,
    },
    price:       { isFree: true, min: 0, max: 0, currency: 'USD' },
    categories:  cleanList(doc.tm_event_tags),
    tags,
    organizer:   ORGANIZER,
    attendance:  null,
    ticketUrl:   url,
    images:      typeof doc.ss_image_url === 'string' && doc.ss_image_url.trim() ? [doc.ss_image_url.trim()] : [],
    rawText:     null,
    neighborhood: branch,
    borough:     BOROUGH,
  };
}

export async function crawl() {
  log(`[${SOURCE_KEY}] Starting crawl`);
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  const allEvents = [];

  try {
    const now = Date.now();
    const cutoff = now + HORIZON_DAYS * 86400000;
    let page = 0;

    while (page < MAX_PAGES) {
      page++;
      log(`[${SOURCE_KEY}] Fetching page ${page}`);

      let res;
      try {
        res = await fetch(`${API_URL}${page}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(20000),
        });
      } catch (fetchErr) {
        logError(`[${SOURCE_KEY}] Network error on page ${page}`, fetchErr);
        errors.push(fetchErr.message);
        break;
      }

      if (!res.ok) {
        logError(`[${SOURCE_KEY}] HTTP ${res.status} on page ${page}`, null);
        errors.push(`HTTP ${res.status}`);
        break;
      }

      let data;
      try {
        data = await res.json();
      } catch (jsonErr) {
        log(`[${SOURCE_KEY}] Failed to parse JSON response on page ${page} — stopping`);
        errors.push(`JSON parse error: ${jsonErr.message}`);
        break;
      }

      if (data?.error) {
        log(`[${SOURCE_KEY}] API refused the request: ${data.error}`);
        errors.push(`API error: ${data.error}`);
        break;
      }

      const docs = extractDocs(data);
      log(`[${SOURCE_KEY}]   Page ${page}: ${docs.length} events`);

      if (docs.length === 0) {
        log(`[${SOURCE_KEY}] Empty page ${page} — stopping`);
        break;
      }

      // Pages are sorted by start date ascending, so the first event past the
      // horizon means everything left is outside the window we store.
      const firstStart = toInstant(docs[0].ds_event_start_date);
      if (firstStart === null || firstStart > cutoff) {
        log(`[${SOURCE_KEY}] Page ${page} starts past the ${HORIZON_DAYS}-day horizon — stopping`);
        break;
      }

      for (const doc of docs) {
        const startMs = toInstant(doc.ds_event_start_date);
        if (startMs === null || startMs < now || startMs > cutoff) continue;
        try {
          const event = mapDoc(doc);
          if (event) allEvents.push(event);
        } catch (err) {
          logError(`[${SOURCE_KEY}] Failed to map event`, err);
          errors.push(`map error: ${err.message}`);
        }
      }

      await sleep(PAGE_DELAY_MS);
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