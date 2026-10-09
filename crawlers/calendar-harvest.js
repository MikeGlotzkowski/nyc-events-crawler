/**
 * Generic calendar / JSON-LD harvester (A4).
 *
 * Given a seed list of venue/organisation URLs, discovers events by trying, in order:
 *   1. WordPress iCal        — `?ical=1` and `/events/?ical=1` (body must be a real VCALENDAR)
 *   2. The Events Calendar   — `/wp-json/tribe/events/v1/events`
 *   3. Sitemap               — `sitemap.xml` → /event, /events/, /calendar/ pages
 *   4. JSON-LD `Event`       — <script type="application/ld+json"> blocks (@graph, array or object)
 *   5. `__NEXT_DATA__`       — best-effort extraction from Next.js page props
 *
 * Results from every mode are deduped by event id. A source that is bot-blocked,
 * returns HTML where a feed was promised, or is otherwise malformed is skipped
 * with a log line — it never fails the run.
 *
 * Reuses the shared primitives: node-ical parsing/expansion and the TZID=UTC
 * wall-clock fix from ical-feeds.js, generateEventId/upsertEvents/crawl-run
 * lifecycle from base-crawler.js, and resolveArea for neighborhood/borough.
 */
import nodeIcal from 'node-ical';
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { localYmd } from '../lib/nyc-time.js';
import { resolveArea } from '../lib/nyc-area.js';
import { decodeEntities } from '../lib/event-filter.js';
import { veventImage, wallClockFix } from './ical-feeds.js';

const SOURCE_KEY      = 'calendar-harvest';
const UA              = 'fomo3-events-bot/1.0 (+https://github.com/fomo3)';
const WINDOW_DAYS     = 90;
const SEED_CONCURRENCY = 5;    // seeds processed in parallel
const MAX_SITEMAP_PAGES = 25;  // event pages fetched per seed
const DOMAIN_DELAY_MS = 750;   // per-domain politeness delay between requests

// ── Seed registry ─────────────────────────────────────────────────
//
// Verified: the venue URL is real and its WordPress events calendar/feed is known
// (the three iCal feeds below are the ones already trusted by crawlers/ical-feeds.js).
// They are seeded here as bare venue roots so this harvester can discover whatever
// else each site publishes (REST, sitemap, JSON-LD), not only the .ics feed.

export const CALENDAR_SEEDS = [
  // ── Verified against crawlers/ical-feeds.js (VCALENDAR confirmed 2026-06-27) ──
  {
    name:         'Green-Wood Cemetery',
    url:          'https://www.green-wood.com',
    neighborhood: 'Greenwood Heights',
    borough:      'Brooklyn',
  },
  {
    name:         "Randall's Island Park",
    url:          'https://www.randallsisland.org',
    neighborhood: "Randall's Island",
    borough:      'Manhattan',
  },
  {
    name:         'Industry City',
    url:          'https://industrycity.com',
    neighborhood: 'Sunset Park',
    borough:      'Brooklyn',
  },
  {
    name:         'Van Cortlandt Park',
    url:          'https://www.vancortlandt.org',
    neighborhood: 'Van Cortlandt Park',
    borough:      'Bronx',
  },
  {
    name:         'Riverside Park',
    url:          'https://riversideparknyc.org',
    neighborhood: 'Upper West Side',
    borough:      'Manhattan',
  },
  // UNVERIFIED: the host is a live NYC arts organisation, but its exact calendar
  // endpoints (iCal/REST/sitemap/JSON-LD) have NOT been confirmed from this repo.
  // Keep it only as a harvest target — modes that do not apply are skipped cleanly.
  {
    name:         'BRIC Arts Media',
    url:          'https://www.bricartsmedia.org',
    neighborhood: 'Fort Greene',
    borough:      'Brooklyn',
  },
];

const SOURCE = (seed) => seed.name;

// ── Small helpers ─────────────────────────────────────────────────

const text = (v) => {
  if (v == null) return null;
  const s = decodeEntities(typeof v === 'string' ? v : String(v)).trim();
  return s || null;
};

function absolute(raw, base) {
  if (!raw || typeof raw !== 'string') return null;
  try { return new URL(raw.trim(), base || undefined).href; } catch { return null; }
}

function startMs(startDate) {
  if (!startDate || typeof startDate !== 'string') return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return Date.parse(`${startDate}T12:00:00Z`);
  return Date.parse(startDate);
}

function inWindow(event, from, to) {
  const ms = startMs(event.startDate);
  return Number.isFinite(ms) && ms >= from.getTime() && ms <= to.getTime();
}

function dedupe(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Build the shared event shape; every mode funnels through here. */
function buildEvent({ source, sourceUrl, title, description, startDate, endDate = null, time = null,
  location = {}, price = {}, categories = [], tags = [], organizer = null, ticketUrl = null,
  images = [], idBase = null }) {
  const url = sourceUrl ?? null;
  return {
    id:          generateEventId(idBase ?? url ?? source.url, title),
    source:      source.name,
    sourceUrl:   url ?? source.url,
    title,
    description: description ?? '',
    startDate:   startDate ?? null,
    endDate:     endDate ?? null,
    time:        time ?? null,
    location: {
      name:    location.name ?? null,
      address: location.address ?? null,
      city:    location.city ?? 'New York',
      lat:     location.lat ?? null,
      lng:     location.lng ?? null,
    },
    price:       { isFree: price.isFree ?? null, min: price.min ?? null, max: price.max ?? null, currency: price.currency ?? 'USD' },
    categories,
    tags,
    organizer:   organizer ?? source.name,
    attendance:  null,
    ticketUrl:   ticketUrl ?? url ?? null,
    images,
    rawText:     null,
    ...resolveArea({ name: location.name, address: location.address, lat: location.lat, lng: location.lng,
      borough: source.borough, neighborhood: source.neighborhood }),
  };
}

// ── Mode 1/2: fetch plumbing ──────────────────────────────────────

/** A real iCal feed starts with BEGIN:VCALENDAR — some sites answer ?ical=1 with an HTML 200. */
export function isIcal(body) {
  return typeof body === 'string' && body.includes('BEGIN:VCALENDAR');
}

async function defaultFetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/calendar,application/json;q=0.8,*/*;q=0.5' },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    const body = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, contentType: res.headers.get('content-type') ?? '', body };
  } catch (err) {
    return { ok: false, status: 0, contentType: '', body: '', error: err.message };
  }
}

async function safeFetch(fetchText, url, delayMs) {
  let res;
  try {
    res = await fetchText(url);
  } catch {
    return { ok: false, status: 0, contentType: '', body: '' };
  }
  await sleep(delayMs);
  return {
    ok:     !!res?.ok,
    status: res?.status ?? 0,
    contentType: res?.contentType ?? '',
    body:   typeof res?.body === 'string' ? res.body : '',
  };
}

// ── Mode 1: WordPress iCal ────────────────────────────────────────

function veventsInWindow(parsed, from, to) {
  const out = [];
  for (const component of Object.values(parsed)) {
    if (component?.type !== 'VEVENT' || !component.start) continue;

    if (component.rrule && from && to) {
      try {
        for (const occ of nodeIcal.expandRecurringEvent(component, { from, to })) {
          out.push({ ...component, start: occ.start, end: occ.end });
        }
        continue;
      } catch {
        // fall through to the base date
      }
    }

    const start = new Date(component.start);
    if (isNaN(start.getTime())) continue;
    if (from && start < from) continue;
    if (to && start > to) continue;
    out.push(component);
  }
  return out;
}

function mapVEvent(vevent, source) {
  const summary = text(typeof vevent.summary === 'string' ? vevent.summary : vevent.summary?.val);
  if (!summary || !vevent.start) return null;

  const toDateValue = (d) => (d.dateOnly ? localYmd(d) : wallClockFix(d).toISOString());
  const startDate = toDateValue(vevent.start);
  const endDate   = vevent.end ? toDateValue(vevent.end) : null;
  const legacyStartIso = new Date(vevent.start).toISOString();

  const location = text(typeof vevent.location === 'string' ? vevent.location : vevent.location?.val);
  const description = text(typeof vevent.description === 'string' ? vevent.description : vevent.description?.val) ?? '';
  const url = vevent.url ? String(vevent.url).trim() || null : null;
  const image = veventImage(vevent);

  return buildEvent({
    source,
    sourceUrl:   url,
    title:       summary,
    description,
    startDate,
    endDate,
    time:        null,
    location:    { name: location ?? source.neighborhood ?? source.name, address: location },
    price:       {},
    categories:  [],
    tags:        ['ical'],
    organizer:   source.name,
    ticketUrl:   url,
    images:      image ? [image] : [],
    idBase:      url ? url : `ical-${source.name}-${legacyStartIso}`,
  });
}

/** Parse a VCALENDAR body into the shared event shape; [] for anything that is not a feed. */
export function parseIcalBody(body, source, { from = null, to = null } = {}) {
  if (!isIcal(body)) return [];
  let parsed;
  try {
    parsed = nodeIcal.parseICS(body);
  } catch {
    return [];
  }
  return dedupe(veventsInWindow(parsed, from, to).map((v) => mapVEvent(v, source)).filter(Boolean));
}

// ── Mode 2: The Events Calendar REST ──────────────────────────────

function mapTribeEvent(ev, source) {
  const title = text(ev?.title);
  if (!title) return null;

  const raw = ev.start_date ?? ev.start_date_details ?? null;
  let startDate = null;
  if (typeof raw === 'string') startDate = raw.replace(' ', 'T');
  else if (raw && typeof raw === 'object' && raw.year) {
    startDate = `${raw.year}-${String(raw.month).padStart(2, '0')}-${String(raw.day).padStart(2, '0')}T${raw.hour ?? '00'}:${raw.minutes ?? '00'}:${raw.seconds ?? '00'}`;
  }
  if (!startDate) return null;
  const endDate = typeof ev.end_date === 'string' ? ev.end_date.replace(' ', 'T') : null;

  const venue = ev.venue && !Array.isArray(ev.venue) ? ev.venue : null;
  const address = [
    venue?.address,
    venue?.city && venue?.zip ? `${venue.city}, NY ${venue.zip}` : (venue?.city ?? null),
  ].filter(Boolean).join(', ') || null;
  const lat = venue?.geo_lat != null && !isNaN(Number(venue.geo_lat)) ? Number(venue.geo_lat) : null;
  const lng = venue?.geo_lng != null && !isNaN(Number(venue.geo_lng)) ? Number(venue.geo_lng) : null;

  const cost = text(ev.cost);
  let price = {};
  if (cost) {
    const nums = [...cost.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    if (/free/i.test(cost)) price = { isFree: true, min: 0, max: 0 };
    else if (nums.length) price = { isFree: false, min: Math.min(...nums), max: Math.max(...nums) };
  }

  const url = text(ev.url);

  return buildEvent({
    source,
    sourceUrl:   url,
    title,
    description: text(ev.description) ?? '',
    startDate,
    endDate,
    time:        null,
    location:    { name: text(venue?.venue) ?? source.name, address, lat, lng, city: text(venue?.city) ?? 'New York' },
    price,
    categories:  Array.isArray(ev.categories) ? ev.categories.map((c) => text(c?.name)).filter(Boolean) : [],
    tags:        ['tribe'],
    organizer:   source.name,
    ticketUrl:   url,
    images:      ev.image?.url ? [text(ev.image.url)].filter(Boolean) : [],
  });
}

/** Map a tribe/events/v1 payload. */
export function mapTribeEvents(payload, source) {
  const rows = payload?.events;
  if (!Array.isArray(rows)) return [];
  return dedupe(rows.map((ev) => mapTribeEvent(ev, source)).filter(Boolean));
}

// ── Mode 3: sitemap ───────────────────────────────────────────────

// Child sitemaps worth following from a sitemap INDEX: the event-relevant ones
// only (e.g. event-sitemap.xml, calendar-sitemap.xml). Page/news/podcast
// sitemaps are noise and must never be crawled.
const EVENT_CHILD_SITEMAP_RE = /event|events|calendar|tribe.?events/i;

/** All <loc> values in a sitemap document, in order. */
function sitemapLocs(xml) {
  const out = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) out.push(m[1].trim());
  return out;
}

/** True for a sitemap INDEX root (<sitemapindex><sitemap><loc>…), false for a URL set. */
export function isSitemapIndex(xml) {
  return typeof xml === 'string' && /<sitemapindex[\s>]/i.test(xml);
}

/**
 * Event page URLs in a URL-set sitemap (<urlset>). Keeps only /event(s)/… and
 * /calendar/… pages. Unchanged A4 behaviour.
 */
export function eventUrlsFromSitemap(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const out = new Set();
  for (const raw of sitemapLocs(xml)) {
    let url;
    try { url = new URL(raw); } catch { continue; }
    const p = url.pathname;
    if (/(^|\/)(event|events)\/[^/]/i.test(p) || /\/calendar\/[^/]/i.test(p)) out.add(url.href);
  }
  return [...out];
}

/**
 * Child sitemap URLs to follow from a sitemap INDEX — only event-relevant ones
 * (name matches /event|events|calendar|tribe.?events/i). [] for a URL set.
 */
export function eventChildSitemapsFromIndex(xml) {
  if (!isSitemapIndex(xml)) return [];
  const out = new Set();
  for (const raw of sitemapLocs(xml)) {
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (EVENT_CHILD_SITEMAP_RE.test(url.pathname)) out.add(url.href);
  }
  return [...out];
}

// ── Mode 4: JSON-LD Event ─────────────────────────────────────────

function* ldNodes(data) {
  if (Array.isArray(data)) {
    for (const n of data) yield* ldNodes(n);
    return;
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data['@graph'])) {
      for (const n of data['@graph']) yield* ldNodes(n);
      return;
    }
    yield data;
  }
}

const isEventType = (t) => [t].flat().some((v) => typeof v === 'string' && (v === 'Event' || /Event$/.test(v)));

function jsonLdImageUrl(image, base) {
  if (!image) return null;
  if (typeof image === 'string') return absolute(image, base);
  if (Array.isArray(image)) {
    for (const i of image) {
      const u = jsonLdImageUrl(i, base);
      if (u) return u;
    }
    return null;
  }
  if (typeof image === 'object') return absolute(image.url ?? image.contentUrl ?? null, base);
  return null;
}

function mapJsonLdLocation(loc) {
  if (!loc) return {};
  if (typeof loc === 'string') return { name: text(loc) };
  const node = Array.isArray(loc) ? loc[0] : loc;
  if (!node || typeof node !== 'object') return {};
  const name = text(node.name);
  const a = node.address;
  let address = null;
  if (typeof a === 'string') address = text(a);
  else if (a && typeof a === 'object') {
    const parts = [text(a.streetAddress), text(a.addressLocality)].filter(Boolean);
    const regionZip = [text(a.addressRegion), text(a.postalCode)].filter(Boolean).join(' ');
    if (regionZip) parts.push(regionZip);
    address = parts.join(', ') || null;
  }
  return { name, address, city: text(a?.addressLocality) ?? 'New York' };
}

function mapJsonLdPrice(offers) {
  const arr = [offers].flat().filter(Boolean);
  let min = null, max = null, isFree = null, currency = 'USD';
  for (const o of arr) {
    const raw = typeof o === 'object' ? (o.price ?? o.lowPrice ?? null) : o;
    if (o && typeof o === 'object' && typeof o.priceCurrency === 'string') currency = o.priceCurrency;
    const num = raw == null ? NaN : Number(String(raw).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(num)) continue;
    min = min == null ? num : Math.min(min, num);
    max = max == null ? num : Math.max(max, num);
  }
  if (min != null) isFree = min === 0;
  return { isFree, min, max, currency };
}

function mapJsonLdEvent(node, source, pageUrl) {
  const title = text(node.name);
  const startDate = text(node.startDate);
  if (!title || !startDate) return null;

  const url = absolute(typeof node.url === 'string' ? node.url : null, pageUrl) ?? pageUrl ?? source.url;
  const organizer = node.organizer ? text(node.organizer.name ?? node.organizer) : null;

  return buildEvent({
    source,
    sourceUrl:   url,
    title,
    description: text(node.description) ?? '',
    startDate,
    endDate:     text(node.endDate),
    time:        null,
    location:    mapJsonLdLocation(node.location),
    price:       mapJsonLdPrice(node.offers),
    categories:  [...new Set([node['@type']].flat().filter((t) => typeof t === 'string'))],
    tags:        ['jsonld'],
    organizer:   organizer ?? source.name,
    ticketUrl:   text(node.offers?.url) ?? url,
    images:      [jsonLdImageUrl(node.image, pageUrl)].filter(Boolean),
    idBase:      node.url ? url : `${source.url}#${startDate}-${title}`,
  });
}

export function extractJsonLdEvents(html, source, pageUrl) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    for (const node of ldNodes(data)) {
      if (!node || typeof node !== 'object' || !isEventType(node['@type'])) continue;
      const e = mapJsonLdEvent(node, source, pageUrl);
      if (e) out.push(e);
    }
  }
  return dedupe(out);
}

// ── Mode 5: __NEXT_DATA__ ─────────────────────────────────────────

function nextDataEvent(obj, source, pageUrl) {
  const title = text(obj.title ?? obj.name ?? obj.eventName);
  const startDate = text(obj.startDate ?? obj.start_date ?? obj.startTime ?? obj.start_datetime ?? obj.date);
  if (!title || !startDate) return null;
  if (!Number.isFinite(startMs(startDate))) return null;

  const origin = absolute(pageUrl, undefined) ? new URL(pageUrl).origin : null;
  const slug = text(obj.slug);
  const url = absolute(obj.url ?? obj.link ?? null, pageUrl)
    ?? (slug && origin ? `${origin}/events/${slug}` : pageUrl ?? source.url);

  const image = jsonLdImageUrl(obj.image_url ?? obj.imageUrl ?? obj.image ?? null, pageUrl);
  const venue = obj.venue ?? obj.location ?? null;
  const location = typeof venue === 'string' ? { name: text(venue) }
    : venue && typeof venue === 'object' ? { name: text(venue.name), address: text(venue.address) }
    : {};

  return buildEvent({
    source,
    sourceUrl:   url,
    title,
    description: text(obj.description ?? obj.summary ?? obj.excerpt) ?? '',
    startDate,
    endDate:     text(obj.endDate ?? obj.end_date),
    time:        null,
    location,
    price:       {},
    categories:  [],
    tags:        ['nextjs'],
    organizer:   source.name,
    ticketUrl:   url,
    images:      [image].filter(Boolean),
    idBase:      obj.url || obj.link ? url : `${source.url}#${startDate}-${title}`,
  });
}

function walkNext(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkNext(item, visit);
    return;
  }
  const mapped = visit(node);
  if (mapped) return; // do not descend into a node that already produced an event
  for (const value of Object.values(node)) walkNext(value, visit);
}

export function extractNextDataEvents(html, source, pageUrl) {
  if (!html || typeof html !== 'string') return [];
  const m = html.match(/<script[^>]*id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const out = [];
  walkNext(data, (obj) => {
    const e = nextDataEvent(obj, source, pageUrl);
    if (e) { out.push(e); return true; }
    return false;
  });
  return dedupe(out);
}

// ── Seed harvesting ───────────────────────────────────────────────

/** Try every discovery mode for one seed, in order, deduping results. Never throws. */
export async function harvestSeed(seed, { fetchText = defaultFetchText, domainDelayMs = DOMAIN_DELAY_MS, now = new Date() } = {}) {
  const base = String(seed.url).replace(/\/+$/, '');
  const from = new Date(now);
  const to   = new Date(now.getTime() + WINDOW_DAYS * 86400000);
  const events = [];
  const add = (list) => {
    for (const e of dedupe(list)) {
      if (!e || events.some((x) => x.id === e.id)) continue;
      if (!inWindow(e, from, to)) continue;
      events.push(e);
    }
  };

  // 1. WordPress iCal
  for (const icalUrl of [`${base}/?ical=1`, `${base}/events/?ical=1`]) {
    const res = await safeFetch(fetchText, icalUrl, domainDelayMs);
    if (!res.ok) continue;
    if (!isIcal(res.body)) {
      log(`[calendar-harvest]   ${seed.name}: ${icalUrl} returned non-iCal (HTTP ${res.status}) — skipping`);
      continue;
    }
    add(parseIcalBody(res.body, seed, { from, to }));
  }
  if (events.length > 0) return events;

  // 2. The Events Calendar REST
  {
    const res = await safeFetch(fetchText, `${base}/wp-json/tribe/events/v1/events`, domainDelayMs);
    const looksJson = res.ok && (/json/.test(res.contentType || '') || res.body.trimStart().startsWith('{'));
    if (looksJson) {
      try {
        add(mapTribeEvents(JSON.parse(res.body), seed));
      } catch {
        log(`[calendar-harvest]   ${seed.name}: tribe REST returned non-JSON — skipping`);
      }
      if (events.length > 0) return events;
    }
  }

  // 3 + 4 / 5. Sitemap → event pages → JSON-LD / __NEXT_DATA__
  {
    const res = await safeFetch(fetchText, `${base}/sitemap.xml`, domainDelayMs);
    if (res.ok && /<urlset|<sitemapindex/i.test(res.body)) {
      // A sitemap INDEX (Yoast/RankMath, The Events Calendar) lists CHILD sitemaps,
      // not pages. Follow ONLY its event-relevant children — exactly one level deep
      // (a child index is not descended into, so nesting/loops cannot run away) —
      // then parse each child that is a plain URL set with the A4 URL-set logic.
      const bodies = [];
      if (isSitemapIndex(res.body)) {
        const children = eventChildSitemapsFromIndex(res.body);
        if (children.length === 0) {
          log(`[calendar-harvest]   ${seed.name}: sitemap index has no event child sitemap — skipping`);
        }
        for (const child of children) {
          const childRes = await safeFetch(fetchText, child, domainDelayMs);
          if (childRes.ok && !isSitemapIndex(childRes.body)) bodies.push(childRes.body);
        }
      } else {
        bodies.push(res.body);
      }

      const urls = [];
      for (const body of bodies) {
        for (const u of eventUrlsFromSitemap(body)) if (!urls.includes(u)) urls.push(u);
      }

      for (const url of urls.slice(0, MAX_SITEMAP_PAGES)) {
        const page = await safeFetch(fetchText, url, domainDelayMs);
        if (!page.ok) continue;
        const found = [...extractJsonLdEvents(page.body, seed, url), ...extractNextDataEvents(page.body, seed, url)];
        if (found.length === 0 && page.body) {
          log(`[calendar-harvest]   ${seed.name}: no event markup at ${url} — skipping`);
        }
        add(found);
      }
    } else {
      log(`[calendar-harvest]   ${seed.name}: no sitemap (HTTP ${res.status}) — skipping`);
    }
  }

  return events;
}

// ── Tiny concurrency pool ─────────────────────────────────────────

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Main entry point ──────────────────────────────────────────────

export async function crawl() {
  log(`[calendar-harvest] Starting crawl — ${CALENDAR_SEEDS.length} seeds`);
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  const events = [];

  const results = await mapPool(CALENDAR_SEEDS, SEED_CONCURRENCY, async (seed) => {
    log(`[calendar-harvest] Processing: ${seed.name}`);
    try {
      return await harvestSeed(seed);
    } catch (err) {
      logError(`[calendar-harvest]   ${seed.name}: harvest failed`, err);
      return { events: [], error: `${seed.name}: ${err.message}` };
    }
  });

  for (const res of results) {
    if (Array.isArray(res)) {
      events.push(...res);
    } else {
      errors.push(res.error);
    }
  }

  const unique = dedupe(events);
  log(`[calendar-harvest] ${unique.length} events across all seeds`);

  let result = { new: 0, updated: 0, errors: [] };
  if (unique.length > 0) {
    result = await upsertEvents(unique);
    errors.push(...result.errors);
  }

  await finishCrawlRun(runId, {
    sourceName:    SOURCE_KEY,
    eventsFound:   unique.length,
    eventsNew:     result.new,
    eventsUpdated: result.updated,
    errors,
  });
  log(`[calendar-harvest] Done — ${result.new} new, ${result.updated} updated`);
}
