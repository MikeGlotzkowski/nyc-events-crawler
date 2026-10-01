/**
 * Queens Public Library Events Crawler
 * Programs live inside the calendar search HTML as
 *   arrJsonData_cal['<jobID>'] = '<json with &quot; quotes>';
 * No browser required — plain HTTP with browser-ish headers (the WAF rejects others).
 */
import https from 'node:https';
import zlib from 'node:zlib';
import { decodeEntities } from '../lib/event-filter.js';
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';

const SOURCE_KEY  = 'queens-library';
const SOURCE      = 'Queens Public Library';
const ORGANIZER   = 'Queens Public Library';
const BASE_URL    = 'https://www.queenslibrary.org';
const SEARCH_URL  = `${BASE_URL}/search/call`;
const IMAGE_BASE  = 'https://image.queenslibrary.org/lamps/styles/event_small/';
const PER_PAGE    = 12;
const MAX_PAGES   = 120;
const PAGE_DELAY_MS = 300;
const WINDOW_DAYS = 14;
const BOROUGH     = 'Queens';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Program types that are not events for the app: classes, drop-in services, support groups.
const SKIP_TYPES = [
  'Computer Classes', 'ESOL', 'Citizenship', 'Coping Skills', 'Job',
  'Health Insurance', 'Tax', 'Financial Literacy', 'Support Group',
];

const nycTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour:      'numeric',
  minute:    '2-digit',
  hour12:    true,
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * GET a page as text with node:https. The site's WAF rejects Node's fetch
 * (undici adds sec-fetch-* headers) but lets a plain HTTPS client through.
 */
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { ...HEADERS, 'Accept-Encoding': 'gzip' }, timeout: 20000 }, (res) => {
      const body = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      const chunks = [];
      body.on('data', c => chunks.push(c));
      body.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      body.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout after 20000ms')));
    req.on('error', reject);
  });
}

function pageUrl(page) {
  return `${SEARCH_URL}?searchField=*&category=calendar&pageParam=${page}&searchFilter=`;
}

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

function splitCategories(raw) {
  return (raw ?? '').split(',').map(c => c.trim()).filter(Boolean);
}

/** unix seconds → '1:30 PM' in NYC wall-clock (narrow/nbsp spaces normalized). */
function nycTimeLabel(ms) {
  if (!Number.isFinite(ms)) return null;
  return nycTimeFmt.format(new Date(ms)).replace(/[\u202f\u00a0]/g, ' ').trim();
}

/** '1:30 PM' or '1:30 PM–3:30 PM' in America/New_York. */
export function formatTimeRange(startMs, endMs) {
  const start = nycTimeLabel(startMs);
  if (!start) return null;
  if (!Number.isFinite(endMs) || endMs <= startMs) return start;
  const end = nycTimeLabel(endMs);
  return end && end !== start ? `${start}–${end}` : start;
}

/**
 * Pull every `arrJsonData_cal['<jobID>'] = '<json>';` statement out of a calendar page.
 * Malformed statements are skipped.
 */
export function parsePrograms(html) {
  const programs = [];
  const re = /arrJsonData_cal\['([^']+)'\]\s*=\s*'(.*?)';/gs;
  let match;
  while ((match = re.exec(html ?? '')) !== null) {
    try {
      const program = JSON.parse(match[2].replace(/&quot;/g, '"'));
      if (program && typeof program === 'object') programs.push(program);
    } catch {
      // broken statement — skip this program
    }
  }
  return programs;
}

/** Virtual-only programs and the low-value program types never reach the feed. */
export function shouldSkip(program) {
  if (!program) return true;
  if (program.delivery_format === 'Virtual') return true;
  const type = program.prgm_type ?? '';
  return SKIP_TYPES.some(t => type.includes(t));
}

/**
 * Expand one program into one event per session inside [now, now + 30 days].
 */
export function mapProgram(program, now = new Date()) {
  if (shouldSkip(program)) return [];

  const title = decodeEntities(program.title).trim();
  if (!title) return [];

  const sourceUrl = program.callUrl ? `${BASE_URL}${program.callUrl}` : `${BASE_URL}/calendar`;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const cutoff = nowMs + WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const description = decodeEntities(stripHtml(program.descr ?? ''));
  const categories = splitCategories(program.prgm_type);
  const image = program.prgm_image ? `${IMAGE_BASE}${program.prgm_image}` : null;
  const tags = ['library', program.prgm_age].filter(Boolean);

  const events = [];
  for (const session of Object.values(program.other_sessions ?? {})) {
    const timestamp = Number(session?.timestamp_GMT);
    if (!Number.isFinite(timestamp)) continue;

    const startMs = timestamp * 1000;
    if (startMs < nowMs || startMs > cutoff) continue;

    const duration = Number(session?.duration);
    const endMs = Number.isFinite(duration) && duration > 0 ? startMs + duration * 1000 : null;

    const branch = session?.location?.branch || program.branch_name || null;

    events.push({
      id:          generateEventId(`${sourceUrl}#${timestamp}`, title),
      source:      SOURCE,
      sourceUrl,
      title,
      description,
      startDate:   new Date(startMs).toISOString(),
      endDate:     endMs ? new Date(endMs).toISOString() : null,
      time:        formatTimeRange(startMs, endMs),
      location: {
        name:    branch ? `${branch} Library` : 'Queens Public Library',
        address: null,
        city:    'New York',
        lat:     null,
        lng:     null,
      },
      price:        { isFree: true, min: 0, max: 0, currency: 'USD' },
      categories,
      tags,
      organizer:    ORGANIZER,
      attendance:   null,
      ticketUrl:    sourceUrl,
      images:       image ? [image] : [],
      rawText:      null,
      neighborhood: branch,
      borough:      BOROUGH,
    });
  }

  return events;
}

export async function crawl() {
  log('[queens-library] Starting crawl');
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  const allEvents = [];
  const seen = new Set();
  const now = new Date();

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = pageUrl(page);
      log(`[queens-library] Fetching page ${page}: ${url}`);

      let res;
      try {
        res = await fetchHtml(url);
      } catch (fetchErr) {
        logError('[queens-library] Network error', fetchErr);
        errors.push(fetchErr.message);
        break;
      }

      if (!res.ok) {
        logError(`[queens-library] HTTP ${res.status}`, null);
        errors.push(`HTTP ${res.status}`);
        break;
      }

      const html = res.text;

      // The WAF answers with HTTP 200 and a "Request Rejected" body.
      if (html.includes('Request Rejected')) {
        logError('[queens-library] Blocked by WAF — Request Rejected', null);
        errors.push('Request Rejected by WAF');
        break;
      }

      const programs = parsePrograms(html);
      log(`[queens-library]   Page ${page}: ${programs.length} programs`);

      for (const program of programs) {
        try {
          // A program can show up on two result pages; keep each session once
          for (const event of mapProgram(program, now)) {
            if (seen.has(event.id)) continue;
            seen.add(event.id);
            allEvents.push(event);
          }
        } catch (err) {
          logError('[queens-library] Failed to map program', err);
          errors.push(`map error: ${err.message}`);
        }
      }

      if (programs.length < PER_PAGE) break;
      await sleep(PAGE_DELAY_MS);
    }

    log(`[queens-library] Total events collected: ${allEvents.length}`);

    let result = { new: 0, updated: 0, errors: [] };
    if (allEvents.length > 0) {
      result = await upsertEvents(allEvents);
      errors.push(...result.errors);
      log(`[queens-library] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);
    } else {
      log('[queens-library] No events found — finishing with 0');
    }

    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   allEvents.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[queens-library] Fatal error', err);
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