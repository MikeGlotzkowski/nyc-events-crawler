/**
 * Time Out New York: "The best things to do in NYC this weekend"
 * One server-rendered list page, rewritten each week. Each numbered tile has a title, link,
 * image and a paragraph or two of copy; dates, times, venue and price live only in that copy,
 * so each tile goes through the LLM extractor. Tiles without a date (permanent attractions)
 * or that ended before the list's date are dropped. No browser required.
 */
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { extractEventsFromPost } from '../lib/llm-extract.js';
import { resolveArea } from '../lib/nyc-area.js';

const SOURCE_KEY = 'timeout';
const SOURCE     = 'Time Out New York';
const BASE_URL   = 'https://www.timeout.com';
const LIST_URL   = `${BASE_URL}/newyork/things-to-do/things-to-do-in-nyc-this-weekend`;
const CONCURRENCY = 4;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html',
};
// Section tags that say nothing about the event.
const GENERIC_TAGS = new Set(['Things to do']);

const ENTITIES = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', rsquo: '\u2019', lsquo: '\u2018',
  rdquo: '\u201d', ldquo: '\u201c', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
};
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
  const n = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
  // Out-of-range runs (mangled emoji) must not throw and kill the crawl.
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return whole;
  return String.fromCodePoint(n);
});
const text = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The list's numbered tiles: { title, url, image, tags, summary, ticketUrl }. */
export function parseTiles(html) {
  const tiles = [];
  for (const m of html.matchAll(/<article[^>]*data-testid="tile-zone-large-list_testID"[^>]*>([\s\S]*?)<\/article>/g)) {
    const body = m[1];
    const heading = body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? '';
    const title = text(heading).replace(/^\d+\.\s*/, '');
    const href = body.match(/<a href="([^"]+)"[^>]*data-testid="tile-link_testID"/)?.[1];
    const summaryHtml = body.match(/data-testid="summary_testID">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const summary = summaryHtml.split(/<\/p>/).map(text).filter(Boolean).join('\n\n');
    if (!title || !href || !summary) continue;
    tiles.push({
      title,
      url:       new URL(decode(href), BASE_URL).href,
      image:     body.match(/<img[^>]*\ssrc="(https:\/\/media\.timeout\.com\/[^"]+)"/)?.[1] ?? null,
      tags:      [...body.matchAll(/<span class="_text_[^"]*">([^<]+)<\/span>/g)].map(t => text(t[1])),
      summary,
      ticketUrl: decode(body.match(/<a[^>]*href="([^"]+)"[^>]*data-testid="buy-now-button_testID"/)?.[1] ?? '') || null,
    });
  }
  return tiles;
}

/** The list's date line, e.g. 2026-09-30T00:00:00-04:00; the LLM reads dates relative to it. */
export function pageDate(html) {
  return html.match(/<time[^>]*dateTime="([^"]+)"/i)?.[1] ?? null;
}

/**
 * One event per tile: the tile's own title, link and image, with the extracted date, venue and price.
 * Null when the extractor found no date, or when it ended before listDay ('YYYY-MM-DD'): films
 * already in theaters and long-running shows come back with an opening date months ago.
 */
export function mapTile(tile, ev, listDay = null) {
  if (!ev?.startDate) return null;
  if (listDay && String(ev.endDate ?? ev.startDate).slice(0, 10) < listDay) return null;
  const location = {
    name:    ev.location?.name ?? null,
    address: ev.location?.address ?? null,
    city:    'New York',
    lat:     null,
    lng:     null,
  };
  return {
    id:          generateEventId(tile.url, tile.title),
    source:      SOURCE,
    sourceUrl:   tile.url,
    title:       tile.title,
    description: ev.description ?? '',
    startDate:   ev.startDate,
    endDate:     ev.endDate ?? null,
    time:        ev.time ?? null,
    location,
    price:       ev.price ?? { isFree: null, min: null, max: null, currency: 'USD' },
    categories:  [...new Set([...tile.tags.filter(t => !GENERIC_TAGS.has(t)), ...(ev.categories ?? [])])],
    tags:        ev.tags ?? [],
    organizer:   null,
    attendance:  null,
    ticketUrl:   tile.ticketUrl ?? ev.ticketUrl ?? null,
    images:      tile.image ? [tile.image] : [],
    rawText:     null,
    ...resolveArea(location),
  };
}

export async function crawl() {
  log('[timeout] Starting crawl');
  const runId = await startCrawlRun(SOURCE_KEY);
  const errors = [];
  let events = [];

  try {
    const res = await fetch(LIST_URL, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const tiles = parseTiles(html);
    if (tiles.length === 0) throw new Error('no tiles on the weekend list');
    const pubDate = pageDate(html);

    const extractTile = async (tile) => {
      try {
        const extracted = await extractEventsFromPost({
          title: tile.title, content: tile.summary, pubDate, postUrl: tile.url, neighborhood: null, borough: null,
        });
        return mapTile(tile, extracted.find(ev => ev?.startDate), pubDate?.slice(0, 10));
      } catch (err) {
        logError(`[timeout] LLM extraction failed for "${tile.title}"`, err);
        errors.push(`"${tile.title}": ${err.message}`);
        return null;
      }
    };
    for (let i = 0; i < tiles.length; i += CONCURRENCY) {
      events.push(...(await Promise.all(tiles.slice(i, i + CONCURRENCY).map(extractTile))).filter(Boolean));
    }
    log(`[timeout] ${events.length} dated events from ${tiles.length} tiles`);

    let result = { new: 0, updated: 0, errors: [] };
    if (events.length > 0) {
      result = await upsertEvents(events);
      errors.push(...result.errors);
    }
    log(`[timeout] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);

    await finishCrawlRun(runId, {
      sourceName:    SOURCE_KEY,
      eventsFound:   events.length,
      eventsNew:     result.new,
      eventsUpdated: result.updated,
      errors,
    });
  } catch (err) {
    logError('[timeout] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, { sourceName: SOURCE_KEY, eventsFound: events.length, errors });
    throw err;
  }
}
