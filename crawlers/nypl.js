/**
 * New York Public Library (NYPL) Events Crawler
 *
 * www.nypl.org is served behind an Imperva/Incapsula edge that answers every
 * path (HTML, sitemap, JSON, static assets — even a headless browser) with the
 * "Incapsula incident" interstitial from non-residential IPs, so the front end
 * is not crawlable from CI. Its Drupal backend, however, is public and NOT
 * behind that edge: https://drupal.nypl.org/jsonapi
 *
 * The event calendar is two resources:
 *   date--event  one row per OCCURRENCE (the actual session date/time), 366k rows
 *   node--event  the PROGRAM (title/body/location/image), 17k published rows
 *
 * Strategy: page `date/event` by an ascending `field_event_date.value` BETWEEN
 * range covering the next 14 days (Drupal's JSON:API compares this datetime
 * field only as a unix timestamp — a bare date string silently matches every
 * row), collect the distinct parent programs, fetch each parent once with the
 * location/image/type includes, then map one event per in-window occurrence.
 * No browser required; plain HTTP.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { cleanText } from '../lib/event-filter.js';
import { nycWallToDate } from '../lib/nyc-time.js';
import { resolveArea } from '../lib/nyc-area.js';

const SOURCE_KEY = 'nypl';
const SOURCE     = 'New York Public Library';
const ORGANIZER  = 'New York Public Library';
const TZ         = 'America/New_York';

const API_ORIGIN     = 'https://drupal.nypl.org';
const EVENT_ENDPOINT = `${API_ORIGIN}/jsonapi/node/event`;
const DATE_ENDPOINT  = `${API_ORIGIN}/jsonapi/date/event`;
// The public front end for links; the API host is where the data lives.
const SITE_ORIGIN    = 'https://www.nypl.org';

const WINDOW_DAYS      = 14;
const PAGE_SIZE        = 50;
const MAX_PAGES        = 200;    // 10k occurrences — a hard stop, not the normal exit
const PARENT_CONCURRENCY = 4;    // parent programs fetched in parallel
const PAGE_DELAY_MS    = 200;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/vnd.api+json',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Sparse fieldsets keep a page near 25 KB instead of 1.4 MB (every resource
// carries a large `metatag` blob by default). `field_ers_parent_event` must be
// listed or the relationship is dropped from the response.
const OCCURRENCE_FIELDS = [
  'drupal_internal__id', 'title', 'field_event_date', 'field_ts_date_status',
  'field_ts_cancellation_reason', 'field_registration', 'field_ers_parent_event',
].join(',');

// Relationships are fields in JSON:API, so a sparse fieldset that omits them
// drops them from the response entirely — the location/image/type relationship
// names must be listed alongside the attributes or nothing resolves.
const PARENT_FIELDS = 'title,body,field_lt_event_format,field_tfls_summary_description,path,field_ts_event_leader_name,'
  + 'field_erm_event_location,field_ers_media_image,field_erm_event_type';
const LOCATION_FIELDS = 'field_erm_event_location,field_erm_event_room,field_ts_external_location,field_bool_both_locations';
const LIBRARY_FIELDS = 'title,field_as_address,field_geos_coordinates,field_ts_location_code';
const TYPE_FIELDS = 'name';
const IMAGE_FIELDS = 'field_media_image';
const FILE_FIELDS = 'uri,url,filename';

const PARENT_INCLUDE = [
  'field_erm_event_location.field_erm_event_location',
  'field_ers_media_image.field_media_image',
  'field_erm_event_type',
].join(',');

const PARENT_FIELDSETS = new URLSearchParams({
  'fields[node--event]': PARENT_FIELDS,
  'fields[paragraph--event_location]': LOCATION_FIELDS,
  'fields[node--library]': LIBRARY_FIELDS,
  'fields[node--center]': LIBRARY_FIELDS,
  'fields[taxonomy_term--event_type]': TYPE_FIELDS,
  'fields[media--image]': IMAGE_FIELDS,
  'fields[file--file]': FILE_FIELDS,
});

const FORM_SPECIFIER = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
});

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// ── Time helpers ─────────────────────────────────────────────────

/** The NYC calendar date of an instant. */
export function nycYmd(now) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

/** ISO instant → ms, or null when the value is missing/unparseable. */
export function toInstant(value) {
  if (!value || typeof value !== 'string' || !FORM_SPECIFIER.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** ISO instant → '10:00 AM' in NYC wall-clock. */
function formatClock(ms) {
  if (!Number.isFinite(ms)) return null;
  return clockFmt.format(new Date(ms)).replace(/[\u202f\u00a0]/g, ' ').trim();
}

/** '10:00 AM' or '10:00 AM–11:00 AM' in America/New_York. */
export function formatTimeRange(startMs, endMs) {
  const start = formatClock(startMs);
  if (!start) return null;
  if (!Number.isFinite(endMs) || endMs <= startMs) return start;
  const end = formatClock(endMs);
  return end && end !== start ? `${start}–${end}` : start;
}

// ── Occurrence parsing ───────────────────────────────────────────

/**
 * Occurrence title → program title. Rows carry a per-session suffix such as
 * "Help on The Way Inc. (Occurrence 7) - 10/11/2026 | 10:00am".
 */
export function titleFromOccurrence(title) {
  return String(title ?? '')
    .replace(/\s*\(Occurrence\s+\d+\)\s*/gi, ' ')
    .replace(/\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}\s*\|\s*\d{1,2}:\d{2}\s*(?:am|pm)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * One `date--event` node → the fields the crawler needs, or null when the row
 * is unusable (no date, no parent, cancelled).
 */
export function parseOccurrence(node) {
  const a = node?.attributes ?? {};
  const startIso = typeof a.field_event_date?.value === 'string' ? a.field_event_date.value : null;
  const startMs = toInstant(startIso);
  if (startMs === null) return null;

  const endMs = toInstant(a.field_event_date?.end_value);
  const parentId = node?.relationships?.field_ers_parent_event?.data?.id ?? null;
  if (!parentId) return null;

  return {
    dateId:   a.drupal_internal__id ?? null,
    title:    typeof a.title === 'string' ? a.title.trim() : '',
    startMs,
    endMs:    endMs !== null && endMs > startMs ? endMs : null,
    canceled: String(a.field_ts_date_status ?? '').toLowerCase() === 'canceled',
    parentId,
  };
}

/** Occurrences whose start falls inside [now, now + WINDOW_DAYS]. */
export function occurrenceInWindow(occ, nowMs, cutoffMs) {
  return !!occ && !occ.canceled && occ.startMs >= nowMs && occ.startMs <= cutoffMs;
}

// ── Parent parsing ───────────────────────────────────────────────

/** Media → image URL. Drupal returns a site-relative `/sites-drupal/...` path. */
function fileUrl(file) {
  const raw = file?.attributes?.url;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { return new URL(raw.trim(), SITE_ORIGIN).href; } catch { return null; }
}

/** The library/center location node → the event's venue. */
function libraryLocation(lib) {
  const a = lib?.attributes ?? {};
  const address = a.field_as_address ?? {};
  const geo = a.field_geos_coordinates ?? {};
  const parts = [address.address_line1, address.locality, [address.administrative_area, address.postal_code].filter(Boolean).join(' ')]
    .filter((s) => typeof s === 'string' && s.trim());
  const formatted = parts.join(', ') || null;
  const lat = Number.isFinite(Number(geo.lat)) && geo.lat !== null ? Number(geo.lat) : null;
  const lng = Number.isFinite(Number(geo.lng)) && geo.lng !== null ? Number(geo.lng) : null;
  return {
    name:    typeof a.title === 'string' && a.title.trim() ? a.title.trim() : null,
    address: formatted,
    city:    typeof address.locality === 'string' && address.locality.trim() ? address.locality.trim() : 'New York',
    lat,
    lng,
  };
}

/**
 * A fetched parent program (single `node--event` resource + its `included`)
 * → the fields the mapper needs. Missing pieces come back null/empty; the
 * caller decides what to do.
 */
export function mapParentResource(payload) {
  const parent = payload?.data;
  if (!parent || parent.type !== 'node--event') return null;
  const a = parent.attributes ?? {};
  const included = Array.isArray(payload.included) ? payload.included : [];
  const byId = new Map(included.map((i) => [`${i.type}:${i.id}`, i]));

  // A relationship's `data` is a single object or an array (event_location is
  // repeated on NYPL nodes); take the first for the single-valued fields we read.
  const refId = (node, rel) => {
    const data = node?.relationships?.[rel]?.data;
    const first = Array.isArray(data) ? data[0] : data;
    return first?.id ?? null;
  };

  const locId = refId(parent, 'field_erm_event_location');
  const paragraph = locId ? byId.get(`paragraph--event_location:${locId}`) : null;
  const libId = refId(paragraph, 'field_erm_event_location');
  const libraryNode = libId ? (byId.get(`node--library:${libId}`) ?? byId.get(`node--center:${libId}`)) : null;

  let location;
  if (libraryNode) {
    location = libraryLocation(libraryNode);
  } else {
    const external = paragraph?.attributes?.field_ts_external_location;
    location = {
      name:    typeof external === 'string' && external.trim() ? external.trim() : 'New York Public Library',
      address: null,
      city:    'New York',
      lat:     null,
      lng:     null,
    };
  }

  const mediaId = refId(parent, 'field_ers_media_image');
  const media = mediaId ? byId.get(`media--image:${mediaId}`) : null;
  const fileId = refId(media, 'field_media_image');
  const image = fileId ? fileUrl(byId.get(`file--file:${fileId}`)) : null;

  const typeId = refId(parent, 'field_erm_event_type');
  const typeName = typeId ? (byId.get(`taxonomy_term--event_type:${typeId}`)?.attributes?.name ?? null) : null;

  const body = typeof a.body?.value === 'string' ? cleanText(a.body.value) : '';
  const summary = typeof a.field_tfls_summary_description?.value === 'string'
    ? cleanText(a.field_tfls_summary_description.value) : '';

  return {
    title:       typeof a.title === 'string' ? cleanText(a.title) : '',
    description: body || summary,
    format:      typeof a.field_lt_event_format === 'string' ? a.field_lt_event_format : null,
    pathAlias:   typeof a.path?.alias === 'string' && a.path.alias.trim() ? a.path.alias.trim() : null,
    typeName:    typeName ? cleanText(typeName) : null,
    location,
    images:      image ? [image] : [],
  };
}

// ── Event mapping ────────────────────────────────────────────────

/** Public event page for a program, or null when it has no alias. */
function buildEventUrl(parent) {
  return parent.pathAlias ? new URL(parent.pathAlias, SITE_ORIGIN).href : null;
}

/**
 * One in-window occurrence + its parent program → the shared event shape.
 * Returns null when the pair cannot make a real event (no title).
 */
export function mapOccurrence(occ, parent) {
  if (!occ || !parent) return null;
  const title = parent.title?.trim() || titleFromOccurrence(occ.title);
  if (!title) return null;

  const url = buildEventUrl(parent) ?? `${API_ORIGIN}/jsonapi/node/event/${occ.parentId}`;
  const tags = ['library'];
  if (parent.format === 'online') tags.push('online');
  else if (parent.format === 'in_person') tags.push('in-person');

  // The branch address carries the ZIP, so resolveArea derives the borough (the
  // app filters on it) and a real NYC neighborhood for each session.
  const name = parent.location?.name ?? 'New York Public Library';
  const area = resolveArea({
    name,
    address: parent.location?.address ?? null,
    lat:     parent.location?.lat ?? null,
    lng:     parent.location?.lng ?? null,
  });

  return {
    // A program repeats; the occurrence start is part of the id so each session is its own event.
    id:          generateEventId(`${url}#${new Date(occ.startMs).toISOString()}`, title),
    source:      SOURCE,
    sourceUrl:   url,
    title,
    description: parent.description ?? '',
    startDate:   new Date(occ.startMs).toISOString(),
    endDate:     occ.endMs ? new Date(occ.endMs).toISOString() : null,
    time:        formatTimeRange(occ.startMs, occ.endMs),
    location: {
      name,
      address: parent.location?.address ?? null,
      city:    parent.location?.city ?? 'New York',
      lat:     parent.location?.lat ?? null,
      lng:     parent.location?.lng ?? null,
    },
    price:       { isFree: true, min: 0, max: 0, currency: 'USD' },
    categories:  parent.typeName ? [parent.typeName] : [],
    tags,
    organizer:   ORGANIZER,
    attendance:  null,
    ticketUrl:   url,
    images:      parent.images ?? [],
    rawText:     null,
    neighborhood: area.neighborhood ?? name,
    borough:     area.borough,
  };
}

// ── HTTP ─────────────────────────────────────────────────────────

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, json };
}

/** `/jsonapi/date/event` page URL for one offset of the window. */
export function occurrencePageUrl(fromSec, toSec, offset) {
  const params = new URLSearchParams({
    'page[limit]': String(PAGE_SIZE),
    'page[offset]': String(offset),
    sort: 'field_event_date.value',
    'fields[date--event]': OCCURRENCE_FIELDS,
  });
  params.append('filter[r][condition][path]', 'field_event_date.value');
  params.append('filter[r][condition][operator]', 'BETWEEN');
  params.append('filter[r][condition][value][]', String(fromSec));
  params.append('filter[r][condition][value][]', String(toSec));
  return `${DATE_ENDPOINT}?${params.toString()}`;
}

/** Single parent program with its location/image/type includes. */
export function parentUrl(uuid) {
  const params = new URLSearchParams({ include: PARENT_INCLUDE });
  for (const [k, v] of PARENT_FIELDSETS) params.append(k, v);
  return `${EVENT_ENDPOINT}/${uuid}?${params.toString()}`;
}

// ── Crawl ────────────────────────────────────────────────────────

/** Fetch one offset of the window. Never throws. */
async function fetchOccurrencePage(fromSec, toSec, offset, errors) {
  let res;
  try {
    res = await getJson(occurrencePageUrl(fromSec, toSec, offset));
  } catch (err) {
    logError(`[${SOURCE_KEY}] Network error at offset ${offset}`, err);
    errors.push(err.message);
    return { rows: [], total: null, failed: true };
  }
  if (!res.ok || !res.json) {
    if (offset === 0 || res.status !== 404) {
      logError(`[${SOURCE_KEY}] HTTP ${res.status} at offset ${offset}`, null);
      errors.push(`HTTP ${res.status}`);
    }
    return { rows: [], total: null, failed: true };
  }
  return { rows: res.json.data ?? [], total: res.json.meta?.count ?? null, failed: false };
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function crawl() {
  log(`[${SOURCE_KEY}] Starting crawl`);
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  const events = [];

  try {
    const now = new Date();
    const nowMs = now.getTime();
    const cutoffMs = nowMs + WINDOW_DAYS * 86400000;
    const { y, m, d } = nycYmd(now);
    const dayStartMs = nycWallToDate(y, m, d).getTime();
    const fromSec = Math.floor(dayStartMs / 1000);
    const toSec = Math.floor(cutoffMs / 1000);

    // 1. Page the occurrence index.
    const occurrences = [];
    for (let page = 0, seen = 0; page < MAX_PAGES; page++) {
      const { rows, total, failed } = await fetchOccurrencePage(fromSec, toSec, seen, errors);
      if (failed || rows.length === 0) break;

      for (const node of rows) {
        const occ = parseOccurrence(node);
        if (occurrenceInWindow(occ, nowMs, cutoffMs)) occurrences.push(occ);
      }
      log(`[${SOURCE_KEY}]   offset ${seen}: +${rows.length} rows (total ${total ?? '?'})`);

      seen += rows.length;
      if (total !== null && seen >= total) break;
      await sleep(PAGE_DELAY_MS);
    }
    log(`[${SOURCE_KEY}] ${occurrences.length} in-window occurrences`);

    // 2. Fetch each distinct parent program once.
    const parentIds = [...new Set(occurrences.map((o) => o.parentId))];
    log(`[${SOURCE_KEY}] Fetching ${parentIds.length} parent programs`);
    const parents = new Map();
    let missingParents = 0;
    await mapPool(parentIds, PARENT_CONCURRENCY, async (uuid) => {
      try {
        const res = await getJson(parentUrl(uuid));
        if (!res.ok || !res.json) {
          // 404/403 = the program itself is unpublished; its sessions are not real events.
          missingParents++;
          return;
        }
        const parent = mapParentResource(res.json);
        if (parent) parents.set(uuid, parent);
        else missingParents++;
      } catch (err) {
        logError(`[${SOURCE_KEY}] Network error for parent ${uuid}`, err);
        errors.push(err.message);
        missingParents++;
      }
    });
    if (missingParents > 0) log(`[${SOURCE_KEY}] ${missingParents} occurrence(s) had no published parent — skipped`);

    // 3. Map each occurrence against its parent.
    const seenIds = new Set();
    for (const occ of occurrences) {
      const parent = parents.get(occ.parentId);
      if (!parent) continue;
      try {
        const event = mapOccurrence(occ, parent);
        if (!event || seenIds.has(event.id)) continue;
        seenIds.add(event.id);
        events.push(event);
      } catch (err) {
        logError(`[${SOURCE_KEY}] Failed to map occurrence`, err);
        errors.push(`map error: ${err.message}`);
      }
    }
    log(`[${SOURCE_KEY}] Total events collected: ${events.length}`);

    let result = { new: 0, updated: 0, errors: [] };
    if (events.length > 0) {
      result = await upsertEvents(events);
      errors.push(...result.errors);
      log(`[${SOURCE_KEY}] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);
    } else {
      log(`[${SOURCE_KEY}] No events found — finishing with 0`);
    }

    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   events.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError(`[${SOURCE_KEY}] Fatal error`, err);
    errors.push(err.message);
    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   events.length,
      eventsNew:     0,
      eventsUpdated: 0,
      errors,
    });
    throw err;
  }
}
