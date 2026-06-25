/**
 * Riverside Park WordPress Events Calendar Crawler
 * Uses The Events Calendar REST API (tribe/events/v1)
 * No browser required — pure HTTP.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';

const SOURCE     = 'Riverside Park';
const ORGANIZER  = 'Riverside Park Conservancy';
const BASE_URL   = 'https://riversideparknyc.org/wp-json/tribe/events/v1/events';
const PER_PAGE   = 50;
const NEIGHBORHOOD = 'Upper West Side';
const BOROUGH    = 'Manhattan';

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTime(dateStr) {
  if (!dateStr) return null;
  try {
    // dateStr is like "2025-06-15 19:30:00"
    const date = new Date(dateStr.replace(' ', 'T'));
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const paddedMinutes = String(minutes).padStart(2, '0');
    return `${hours}:${paddedMinutes} ${ampm}`;
  } catch {
    return null;
  }
}

function parseStartDate(event) {
  // Prefer start_date (ISO-like string e.g. "2025-06-15 10:00:00")
  if (event.start_date) {
    try {
      return new Date(event.start_date.replace(' ', 'T')).toISOString();
    } catch { /* fall through */ }
  }
  // Try start_date_details object
  const d = event.start_date_details;
  if (d?.year && d?.month && d?.day) {
    const iso = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}T${d.hour ?? '00'}:${d.minutes ?? '00'}:${d.seconds ?? '00'}`;
    try { return new Date(iso).toISOString(); } catch { /* fall through */ }
  }
  return null;
}

function parseEndDate(event) {
  if (event.end_date) {
    try {
      return new Date(event.end_date.replace(' ', 'T')).toISOString();
    } catch { /* fall through */ }
  }
  return null;
}

function mapEvent(event) {
  const venue = event.venue ?? null;

  const locationName = venue?.venue ?? null;
  const locationAddress = [
    venue?.address,
    venue?.city && venue?.zip ? `${venue.city}, NY ${venue.zip}` : (venue?.city ?? null),
  ].filter(Boolean).join(', ') || null;

  const lat = venue?.geo_lat ? parseFloat(venue.geo_lat) : null;
  const lng = venue?.geo_lng ? parseFloat(venue.geo_lng) : null;

  const title = stripHtml(event.title ?? '');
  const url   = event.url ?? '';

  return {
    id:          generateEventId(url, title),
    source:      SOURCE,
    sourceUrl:   url,
    title,
    description: stripHtml(event.description ?? ''),
    startDate:   parseStartDate(event),
    endDate:     parseEndDate(event),
    time:        formatTime(event.start_date ?? null),
    location: {
      name:    locationName,
      address: locationAddress,
      city:    venue?.city ?? 'New York',
      lat:     isNaN(lat) ? null : lat,
      lng:     isNaN(lng) ? null : lng,
    },
    price:       { isFree: null, min: null, max: null, currency: 'USD' },
    categories:  [],
    tags:        [],
    organizer:   ORGANIZER,
    attendance:  null,
    ticketUrl:   url,
    images:      event.image?.url ? [event.image.url] : [],
    rawText:     null,
    neighborhood: NEIGHBORHOOD,
    borough:     BOROUGH,
  };
}

export async function crawl() {
  log('[riverside-park] Starting crawl');
  const runId = await startCrawlRun('riverside-park');
  const errors = [];
  const allEvents = [];

  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    let nextUrl = `${BASE_URL}?per_page=${PER_PAGE}&status=publish&start_date=${today}`;
    let pageNum = 0;

    while (nextUrl) {
      pageNum++;
      log(`[riverside-park] Fetching page ${pageNum}: ${nextUrl}`);

      let res;
      try {
        res = await fetch(nextUrl, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'fomo3-events-bot/1.0' },
          signal: AbortSignal.timeout(20000),
        });
      } catch (fetchErr) {
        logError('[riverside-park] Network error', fetchErr);
        errors.push(fetchErr.message);
        break;
      }

      if (res.status === 404) {
        log('[riverside-park] Endpoint returned 404 — no events or endpoint unavailable');
        break;
      }

      if (!res.ok) {
        logError(`[riverside-park] HTTP ${res.status}`, null);
        errors.push(`HTTP ${res.status}`);
        break;
      }

      // Check content-type before parsing JSON
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) {
        log(`[riverside-park] Non-JSON response (content-type: ${contentType}) — skipping`);
        break;
      }

      let data;
      try {
        data = await res.json();
      } catch (jsonErr) {
        log('[riverside-park] Failed to parse JSON response — skipping');
        errors.push(`JSON parse error: ${jsonErr.message}`);
        break;
      }

      const events = data.events ?? [];
      log(`[riverside-park]   Page ${pageNum}: ${events.length} events`);

      for (const ev of events) {
        try {
          allEvents.push(mapEvent(ev));
        } catch (err) {
          logError(`[riverside-park] Failed to map event`, err);
          errors.push(`map error: ${err.message}`);
        }
      }

      // Pagination via next_rest_url
      nextUrl = data.next_rest_url ?? null;
    }

    log(`[riverside-park] Total events collected: ${allEvents.length}`);

    if (allEvents.length > 0) {
      const result = await upsertEvents(allEvents);
      errors.push(...result.errors);
      log(`[riverside-park] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);

      await finishCrawlRun(runId, {
        sourceName:    'riverside-park',
        eventsFound:   allEvents.length,
        eventsNew:     result.new,
        eventsUpdated: result.updated,
        errors,
      });
    } else {
      log('[riverside-park] No events found — finishing with 0');
      await finishCrawlRun(runId, {
        sourceName:    'riverside-park',
        eventsFound:   0,
        eventsNew:     0,
        eventsUpdated: 0,
        errors,
      });
    }
  } catch (err) {
    logError('[riverside-park] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, {
      sourceName:    'riverside-park',
      eventsFound:   allEvents.length,
      eventsNew:     0,
      eventsUpdated: 0,
      errors,
    });
    throw err;
  }
}
