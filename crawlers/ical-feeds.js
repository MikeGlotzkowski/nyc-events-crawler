/**
 * iCal Feeds Crawler
 * Fetches .ics feeds from NYC museums, venues, and parks, parses with node-ical,
 * expands recurring events (RRULE), and maps into the event schema.
 * A failed feed logs and is skipped — it never fails the overall run.
 */
import nodeIcal from 'node-ical';
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { localYmd, nycWallToDate } from '../lib/nyc-time.js';
import { resolveArea } from '../lib/nyc-area.js';
import { cleanImageUrl, fetchPageImage } from '../lib/og-image.js';

// ── Source registry ───────────────────────────────────────────────
// Verified: each URL returns a valid VCALENDAR (checked 2026-06-27).

export const ICAL_SOURCES = [
  // Parks & outdoor spaces
  // Prospect Park Alliance (https://www.prospectpark.org/?ical=1) is off: Cloudflare serves a
  // bot challenge (403, cf-mitigated: challenge) to GitHub Actions IPs on every endpoint,
  // whatever the headers. It works from residential IPs only. Checked 2026-10-01.
  {
    name:         "Green-Wood Cemetery",
    feed:         'https://www.green-wood.com/events/?ical=1',
    neighborhood: 'Greenwood Heights',
    borough:      'Brooklyn',
  },
  {
    name:         "Randall's Island Park",
    feed:         'https://www.randallsisland.org/events/?ical=1',
    neighborhood: "Randall's Island",
    borough:      'Manhattan',
  },
  // Mixed-use creative districts
  {
    name:         'Industry City',
    feed:         'https://industrycity.com/events/?ical=1',
    neighborhood: 'Sunset Park',
    borough:      'Brooklyn',
  },
];

// ── Forward window ────────────────────────────────────────────────

const WINDOW_DAYS = 90;

function windowBounds() {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + WINDOW_DAYS);
  return { start: now, end };
}

// ── iCal parsing ─────────────────────────────────────────────────

async function fetchAndParseIcal(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'fomo3-events-bot/1.0 (+https://github.com/fomo3)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Response is not a valid iCal feed');
  return nodeIcal.parseICS(text);
}

function expandEvents(parsedData, windowStart, windowEnd) {
  const events = [];

  for (const [, component] of Object.entries(parsedData)) {
    if (component.type !== 'VEVENT') continue;

    if (component.rrule) {
      // Expand recurring events within the forward window
      try {
        const occurrences = nodeIcal.expandRecurringEvent(component, { from: windowStart, to: windowEnd });
        for (const occurrence of occurrences) {
          events.push({ ...component, start: occurrence.start, end: occurrence.end });
        }
      } catch {
        // If RRULE expansion fails, just try the base date
        if (component.start && component.start >= windowStart && component.start <= windowEnd) {
          events.push(component);
        }
      }
    } else {
      // Single event — include if it falls within the window
      const start = component.start ? new Date(component.start) : null;
      if (!start) continue;
      if (start >= windowStart && start <= windowEnd) {
        events.push(component);
      }
    }
  }

  return events;
}

// ── Images ───────────────────────────────────────────────────────

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;
const PAGE_FETCH_CONCURRENCY = 4;

/** Image from a VEVENT's ATTACH/IMAGE property (The Events Calendar feeds set ATTACH;FMTTYPE=image/*). */
export function veventImage(vevent) {
  for (const key of ['attach', 'image']) {
    const values = [vevent[key] ?? []].flat();
    for (const v of values) {
      const raw  = typeof v === 'string' ? v : v?.val;
      const type = typeof v === 'object' ? v?.params?.FMTTYPE ?? v?.params?.fmttype : null;
      if (typeof raw !== 'string') continue;
      if (!(type?.startsWith('image/') || IMAGE_EXT_RE.test(raw))) continue;
      const url = cleanImageUrl(raw);
      if (url) return url;
    }
  }
  return null;
}

/** Fill in images for events whose VEVENT had none, from their event page's og:image. */
async function addPageImages(events, source) {
  const missing = events.filter(e => e.images.length === 0 && e.sourceUrl && e.sourceUrl !== source.feed);
  for (let i = 0; i < missing.length; i += PAGE_FETCH_CONCURRENCY) {
    await Promise.all(missing.slice(i, i + PAGE_FETCH_CONCURRENCY).map(async (event) => {
      const image = await fetchPageImage(event.sourceUrl);
      if (image) event.images = [image];
    }));
  }
}

/**
 * Industry City and Randall's Island run WordPress set to UTC, so their feeds label NYC
 * wall-clock times TZID=UTC (a 7pm show arrives as 19:00 UTC, i.e. 3pm). A NYC venue never
 * means UTC, so read TZID=UTC times as NYC wall clock. A real UTC instant ("...Z") parses
 * as Etc/UTC and is left alone.
 */
export function wallClockFix(d) {
  if (d.tz !== 'UTC') return new Date(d);
  return nycWallToDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
}

function mapVEvent(vevent, source) {
  const summary = (typeof vevent.summary === 'string' ? vevent.summary : vevent.summary?.val ?? '').trim();
  if (!summary) return null;

  if (!vevent.start) return null;
  // Timed events are real instants; all-day (VALUE=DATE) values are local midnight → keep the calendar date.
  const toDateValue = (d) => d.dateOnly ? localYmd(d) : wallClockFix(d).toISOString();
  const startDate = toDateValue(vevent.start);
  const endDate   = vevent.end ? toDateValue(vevent.end) : null;
  const legacyStartIso = new Date(vevent.start).toISOString(); // id input — keep stable across this fix

  const location  = (typeof vevent.location === 'string' ? vevent.location : vevent.location?.val ?? '').trim() || null;
  const description = (typeof vevent.description === 'string' ? vevent.description : vevent.description?.val ?? '').trim();
  const url       = (vevent.url ?? '').toString().trim() || null;
  const image     = veventImage(vevent);

  const id = url
    ? generateEventId(url, summary)
    : generateEventId(`ical-${source.name}-${legacyStartIso}`, summary);

  return {
    id,
    source:      source.name,
    sourceUrl:   url ?? source.feed,
    title:       summary,
    description: description ?? '',
    startDate,
    endDate,
    time:        null,
    location: {
      name:    location ?? source.neighborhood ?? source.name,
      address: location ?? null,
      city:    'New York',
      lat:     null,
      lng:     null,
    },
    price:       { isFree: null, min: null, max: null, currency: 'USD' },
    categories:  [],
    tags:        ['ical'],
    organizer:   source.name,
    attendance:  null,
    ticketUrl:   url,
    images:      image ? [image] : [],
    rawText:     null,
    ...resolveArea({ name: location, borough: source.borough, neighborhood: source.neighborhood }),
  };
}

// ── Process a single source ───────────────────────────────────────

async function processSource(source) {
  log(`[ical-feeds] Processing: ${source.name}`);
  const { start, end } = windowBounds();

  let parsedData;
  try {
    parsedData = await fetchAndParseIcal(source.feed);
  } catch (err) {
    logError(`[ical-feeds]   ${source.name}: fetch/parse failed`, err);
    return { events: [], errors: [`${source.name}: ${err.message}`] };
  }

  const vevents = expandEvents(parsedData, start, end);
  log(`[ical-feeds]   ${source.name}: ${vevents.length} events in window`);

  const events = vevents.map(v => mapVEvent(v, source)).filter(Boolean);
  await addPageImages(events, source);
  log(`[ical-feeds]   ${source.name}: ${events.length} mapped, ${events.filter(e => e.images.length).length} with images`);

  return { events, errors: [] };
}

// ── Main entry point ──────────────────────────────────────────────

export async function crawl() {
  log(`[ical-feeds] Starting crawl — ${ICAL_SOURCES.length} sources`);
  const runId = await startCrawlRun('ical-feeds');
  const allErrors = [];
  let totalFound = 0, totalNew = 0, totalUpdated = 0;

  for (const source of ICAL_SOURCES) {
    const { events, errors } = await processSource(source);
    allErrors.push(...errors);

    if (events.length > 0) {
      const result = await upsertEvents(events);
      totalFound   += events.length;
      totalNew     += result.new;
      totalUpdated += result.updated;
      allErrors.push(...result.errors);
    }
  }

  log(`[ical-feeds] Done — ${totalNew} new, ${totalUpdated} updated across all sources`);

  await finishCrawlRun(runId, {
    sourceName:    'ical-feeds',
    eventsFound:   totalFound,
    eventsNew:     totalNew,
    eventsUpdated: totalUpdated,
    errors:        allErrors,
  });
}
