/**
 * NYC Parks RSS Crawler
 * Source: https://www.nycgovparks.org/xml/events_300_rss.xml
 * No browser needed — pure RSS fetch.
 */
import { parseStringPromise } from 'xml2js';
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';

const RSS_URL = 'https://www.nycgovparks.org/xml/events_300_rss.xml';
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

function parseItem(item) {
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
    const coords    = item['event:coordinates']?.[0];
    const imageUrl  = item['event:image']?.[0]     ?? null;
    const categories = (item['event:categories']?.[0] ?? '').split(',').map(c => c.trim()).filter(Boolean);

    const [lat, lng] = coords ? coords.split(',').map(v => parseFloat(v.trim())) : [null, null];

    const event = {
      id:          generateEventId(link, title),
      source:      SOURCE,
      sourceUrl:   link,
      title,
      description:  description ?? '',
      startDate:    startDate ? new Date(startDate).toISOString() : null,
      endDate:      endDate   ? new Date(endDate).toISOString()   : null,
      time:         startTime && endTime ? `${startTime}–${endTime}` : startTime,
      location: {
        name:    parkNames ?? location ?? 'NYC Park',
        address: location ?? null,
        city:    'New York',
        lat:     isNaN(lat) ? null : lat,
        lng:     isNaN(lng) ? null : lng,
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
      borough:      parseBoroughFromParkName(parkNames),
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
    const res = await fetch(RSS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    const parsed = await parseStringPromise(xml, { explicitArray: true });
    const items  = parsed?.rss?.channel?.[0]?.item ?? [];

    log(`[nyc-parks] Found ${items.length} items in RSS feed`);

    const events = items.map(parseItem).filter(Boolean);
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
