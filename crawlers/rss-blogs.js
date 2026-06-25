/**
 * Neighborhood Blog RSS Crawler
 * Fetches RSS feeds from NYC neighborhood blogs, extracts event posts,
 * then uses GPT-4o-mini to parse structured event data from blog text.
 */
import { parseStringPromise } from 'xml2js';
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';
import { extractEventsFromPost, looksLikeEventPost } from '../lib/llm-extract.js';

// ── Source registry ───────────────────────────────────────────

export const RSS_SOURCES = [
  // Manhattan — Upper West Side
  { name: 'I Love The Upper West Side', feed: 'https://www.ilovetheupperwestside.com/feed/', neighborhood: 'Upper West Side', borough: 'Manhattan' },
  { name: 'West Side Rag',              feed: 'https://www.westsiderag.com/feed/',           neighborhood: 'Upper West Side', borough: 'Manhattan' },
  // Manhattan — Harlem
  { name: 'Harlem World Magazine',      feed: 'https://harlemworldmagazine.com/feed/',        neighborhood: 'Harlem',          borough: 'Manhattan' },
  // Manhattan — East/Lower East Side
  { name: 'EV Grieve',                  feed: 'https://evgrieve.com/feeds/posts/default',     neighborhood: 'East Village',    borough: 'Manhattan' },
  { name: 'Bedford + Bowery',           feed: 'https://bedfordandbowery.com/feed/',           neighborhood: 'Lower East Side', borough: 'Manhattan' },
  // Citywide
  { name: 'Gothamist',                  feed: 'https://gothamist.com/feed',                   neighborhood: null,              borough: null },
  { name: 'The Skint',                  feed: 'https://theskint.com/rss',                     neighborhood: null,              borough: null },
  // Brooklyn
  { name: 'Brooklyn Paper',             feed: 'https://www.brooklynpaper.com/feed/',          neighborhood: null,              borough: 'Brooklyn' },
  { name: 'Bklyner',                    feed: 'https://bklyner.com/feed/',                    neighborhood: null,              borough: 'Brooklyn' },
  { name: 'Greenpointers',              feed: 'https://greenpointers.com/feed/',              neighborhood: 'Greenpoint',      borough: 'Brooklyn' },
  { name: 'Bushwick Daily',             feed: 'https://bushwickdaily.com/feed/',              neighborhood: 'Bushwick',        borough: 'Brooklyn' },
  { name: 'Brownstoner',                feed: 'https://www.brownstoner.com/feed/',            neighborhood: null,              borough: 'Brooklyn' },
  // Queens
  { name: 'QNS',                        feed: 'https://qns.com/feed/',                        neighborhood: null,              borough: 'Queens' },
  { name: 'Astoria Post',               feed: 'https://astoriapost.com/feed/',                neighborhood: 'Astoria',         borough: 'Queens' },
  // Bronx
  { name: 'Bronx Times',                feed: 'https://www.bxtimes.com/feed/',               neighborhood: null,              borough: 'The Bronx' },
  // Note: Patch.com no longer offers RSS feeds (returns sitemaps). Removed.
];

// ── RSS fetch + parse ─────────────────────────────────────────

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'fomo3-events-bot/1.0 (+https://github.com/fomo3)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: true });

  // Handle both RSS 2.0 and Atom
  const channel = parsed?.rss?.channel?.[0];
  if (channel) {
    return (channel.item ?? []).map(item => ({
      title:   item.title?.[0]?.trim() ?? '',
      link:    item.link?.[0]?.trim()  ?? '',
      pubDate: item.pubDate?.[0]?.trim() ?? null,
      content: (item['content:encoded']?.[0] ?? item.description?.[0] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    }));
  }

  // Atom feed
  const feed = parsed?.feed;
  if (feed) {
    return (feed.entry ?? []).map(entry => ({
      title:   (Array.isArray(entry.title) ? entry.title[0]?._ ?? entry.title[0] : entry.title) ?? '',
      link:    entry.link?.[0]?.['$']?.href ?? '',
      pubDate: entry.updated?.[0] ?? entry.published?.[0] ?? null,
      content: (entry.content?.[0]?._ ?? entry.summary?.[0] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    }));
  }

  return [];
}

// ── Process a single source ───────────────────────────────────

async function processSource(source) {
  log(`[rss-blogs] Processing: ${source.name}`);
  const sourceErrors = [];
  const allEvents = [];

  let items;
  try {
    items = await fetchFeed(source.feed);
    log(`[rss-blogs]   ${source.name}: ${items.length} feed items`);
  } catch (err) {
    logError(`[rss-blogs]   ${source.name}: feed fetch failed`, err);
    return { events: [], errors: [`${source.name}: ${err.message}`] };
  }

  for (const item of items) {
    if (!item.title || !item.link) continue;

    // Skip items that clearly aren't event-related
    if (!looksLikeEventPost(item.title, item.content)) continue;

    try {
      const extracted = await extractEventsFromPost({
        title:        item.title,
        content:      item.content,
        pubDate:      item.pubDate,
        postUrl:      item.link,
        neighborhood: source.neighborhood,
        borough:      source.borough,
      });

      for (const ev of extracted) {
        if (!ev.title) continue;
        allEvents.push({
          id:          generateEventId(item.link, ev.title),
          source:      source.name,
          sourceUrl:   ev.ticketUrl ?? item.link,
          title:       ev.title,
          description: ev.description ?? '',
          startDate:   ev.startDate   ? new Date(ev.startDate).toISOString()  : null,
          endDate:     ev.endDate     ? new Date(ev.endDate).toISOString()    : null,
          time:        ev.time        ?? null,
          location:    { name: ev.location?.name ?? null, address: ev.location?.address ?? null, city: 'New York', lat: null, lng: null },
          price:       ev.price       ?? { isFree: null, min: null, max: null, currency: 'USD' },
          categories:  ev.categories  ?? [],
          tags:        ev.tags        ?? [],
          organizer:   null,
          attendance:  null,
          ticketUrl:   ev.ticketUrl   ?? null,
          images:      [],
          rawText:     null,
          neighborhood: source.neighborhood,
          borough:      source.borough,
        });
      }
    } catch (err) {
      logError(`[rss-blogs]   LLM extraction failed for "${item.title}"`, err);
      sourceErrors.push(`${source.name} — "${item.title}": ${err.message}`);
    }
  }

  log(`[rss-blogs]   ${source.name}: ${allEvents.length} events extracted`);
  return { events: allEvents, errors: sourceErrors };
}

// ── Main entry point ──────────────────────────────────────────

export async function crawl(sourceFilter = null) {
  const sources = sourceFilter
    ? RSS_SOURCES.filter(s => s.name.toLowerCase().includes(sourceFilter.toLowerCase()))
    : RSS_SOURCES;

  log(`[rss-blogs] Starting crawl — ${sources.length} sources`);
  const runId = await startCrawlRun('rss-blogs');
  const allErrors = [];
  let totalEvents = 0, totalNew = 0, totalUpdated = 0;

  for (const source of sources) {
    const { events, errors } = await processSource(source);
    allErrors.push(...errors);

    if (events.length > 0) {
      const result = await upsertEvents(events);
      totalEvents   += events.length;
      totalNew      += result.new;
      totalUpdated  += result.updated;
      allErrors.push(...result.errors);
    }
  }

  log(`[rss-blogs] Done — ${totalNew} new, ${totalUpdated} updated across all sources`);

  await finishCrawlRun(runId, {
    sourceName:    'rss-blogs',
    eventsFound:   totalEvents,
    eventsNew:     totalNew,
    eventsUpdated: totalUpdated,
    errors:        allErrors,
  });
}
