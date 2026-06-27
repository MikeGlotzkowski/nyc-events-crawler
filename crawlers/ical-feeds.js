/**
 * iCal Feeds Crawler
 * Fetches .ics feeds from NYC museums, venues, and parks, parses with node-ical,
 * expands recurring events (RRULE), and maps into the event schema.
 * A failed feed logs and is skipped — it never fails the overall run.
 */
import nodeIcal from 'node-ical';
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';

// ── Source registry ───────────────────────────────────────────────
// Verified: each URL returns a valid VCALENDAR (checked 2026-06-27).

export const ICAL_SOURCES = [
  // Parks & outdoor spaces
  {
    name:         'Prospect Park Alliance',
    feed:         'https://www.prospectpark.org/?ical=1',
    neighborhood: 'Prospect Park',
    borough:      'Brooklyn',
  },
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
        const occurrences = nodeIcal.expandRecurringEvent(component, windowStart, windowEnd);
        for (const occurrence of occurrences) {
          events.push({ ...component, start: occurrence });
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

function mapVEvent(vevent, source) {
  const summary = (typeof vevent.summary === 'string' ? vevent.summary : vevent.summary?.val ?? '').trim();
  if (!summary) return null;

  const startDate = vevent.start ? new Date(vevent.start).toISOString() : null;
  const endDate   = vevent.end   ? new Date(vevent.end).toISOString()   : null;
  if (!startDate) return null;

  const location  = (typeof vevent.location === 'string' ? vevent.location : vevent.location?.val ?? '').trim() || null;
  const description = (typeof vevent.description === 'string' ? vevent.description : vevent.description?.val ?? '').trim();
  const url       = (vevent.url ?? '').toString().trim() || null;

  const id = url
    ? generateEventId(url, summary)
    : generateEventId(`ical-${source.name}-${startDate}`, summary);

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
    images:      [],
    rawText:     null,
    neighborhood: source.neighborhood ?? null,
    borough:      source.borough ?? null,
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
  log(`[ical-feeds]   ${source.name}: ${events.length} mapped`);

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
