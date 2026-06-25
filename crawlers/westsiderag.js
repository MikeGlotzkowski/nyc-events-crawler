/**
 * West Side Rag — Weekly Events Page Playwright Scraper
 * URL: https://www.westsiderag.com/this-weeks-events
 *
 * The page lists events grouped under date headers like "Monday, June 2nd".
 * Each event has a time range, linked title, description, and optional address.
 */
import { chromium } from 'playwright';
import { generateEventId, log, logError, startCrawlRun, finishCrawlRun, upsertEvents } from '../lib/base-crawler.js';

const SOURCE       = 'West Side Rag';
const PAGE_URL     = 'https://www.westsiderag.com/this-weeks-events';
const NEIGHBORHOOD = 'Upper West Side';
const BOROUGH      = 'Manhattan';

/**
 * Parse a date header like "Monday, June 2nd" into an ISO date string.
 * Uses the current year; if the derived date is in the past by > 300 days
 * we bump to next year to handle year-end edge cases.
 */
function parseDateHeader(headerText) {
  if (!headerText) return null;
  try {
    // Strip ordinal suffixes: "2nd" → "2", "21st" → "21"
    const normalized = headerText.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
    // Remove day-of-week prefix: "Monday, June 2" → "June 2"
    const withoutDay = normalized.replace(/^[A-Za-z]+,?\s*/, '');
    const year = new Date().getFullYear();
    const attempt = new Date(`${withoutDay} ${year}`);
    if (isNaN(attempt.getTime())) return null;

    // If more than ~300 days in the past, assume next year
    const now = Date.now();
    if (attempt.getTime() < now - 300 * 24 * 60 * 60 * 1000) {
      attempt.setFullYear(year + 1);
    }
    return attempt.toISOString().split('T')[0]; // YYYY-MM-DD
  } catch {
    return null;
  }
}

function buildIso(dateStr, timeStr) {
  if (!dateStr) return null;
  if (!timeStr) return `${dateStr}T00:00:00.000Z`;
  try {
    // timeStr e.g. "7:00 PM" or "7:00 PM – 9:00 PM"
    const startTime = timeStr.split(/[–—-]/)[0].trim();
    const d = new Date(`${dateStr} ${startTime}`);
    if (isNaN(d.getTime())) return `${dateStr}T00:00:00.000Z`;
    return d.toISOString();
  } catch {
    return `${dateStr}T00:00:00.000Z`;
  }
}

function normalizeTime(rawTime) {
  if (!rawTime) return null;
  return rawTime.trim().replace(/\s+/g, ' ');
}

export async function crawl() {
  log('[westsiderag] Starting crawl');
  const runId = await startCrawlRun('westsiderag');
  const errors = [];
  const allEvents = [];

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
    });
    const page = await context.newPage();

    log(`[westsiderag] Navigating to ${PAGE_URL}`);
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Extract raw event data from the DOM
    const rawEvents = await page.evaluate(() => {
      const results = [];
      let currentDateHeader = null;

      // Walk through all elements in the main content area
      // Look for h3/h4/strong elements that are date headers, then collect
      // the event entries that follow until the next header.
      const content = document.querySelector('.entry-content, article, main, #content, .post-content');
      const container = content || document.body;

      const children = Array.from(container.querySelectorAll('*'));

      // Strategy: walk all block-level + heading elements in order
      // A date header is bold/heading text matching a weekday pattern
      const WEEKDAYS = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i;

      // Collect paragraphs and headings in document order
      const blocks = Array.from(container.querySelectorAll(
        'h1, h2, h3, h4, h5, h6, p, li, div.event, .tribe_events_cat, strong'
      ));

      // Deduplicate by text to avoid double-processing inline elements
      const seen = new Set();
      const unique = blocks.filter(el => {
        const t = el.textContent?.trim();
        if (!t || seen.has(t)) return false;
        // Only keep elements whose direct parent isn't also in our list
        seen.add(t);
        return true;
      });

      for (const el of unique) {
        const text = el.textContent?.trim() ?? '';
        if (!text) continue;

        // Detect date header
        if (WEEKDAYS.test(text) && text.length < 60 &&
            (el.tagName.match(/^H[1-6]$/) ||
             el.tagName === 'STRONG' ||
             el.tagName === 'B' ||
             el.style?.fontWeight === 'bold')) {
          currentDateHeader = text;
          continue;
        }

        if (!currentDateHeader) continue;

        // Detect an event entry: must have an anchor child (the event title link)
        const link = el.querySelector('a');
        if (!link) continue;

        const title = link.textContent?.trim();
        if (!title || title.length < 3) continue;

        // Extract time: text before the link that looks like a time range
        const fullText = el.textContent.trim();
        const timeMatch = fullText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)(?:\s*[–—-]\s*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))?)/i);
        const time = timeMatch ? timeMatch[1] : null;

        // Description: remaining text after removing time and title
        let desc = fullText
          .replace(timeMatch?.[0] ?? '', '')
          .replace(title, '')
          .trim()
          .replace(/^[–—:-]+\s*/, '')
          .trim();

        const href = link.href || null;

        results.push({
          dateHeader: currentDateHeader,
          title,
          time,
          description: desc || null,
          eventUrl: href,
        });
      }

      return results;
    });

    log(`[westsiderag] Extracted ${rawEvents.length} raw event entries from DOM`);

    for (const raw of rawEvents) {
      if (!raw.title) continue;

      const dateStr = parseDateHeader(raw.dateHeader);
      const startDate = buildIso(dateStr, raw.time);
      const eventUrl = raw.eventUrl || PAGE_URL;

      allEvents.push({
        id:          generateEventId(eventUrl, raw.title),
        source:      SOURCE,
        sourceUrl:   eventUrl,
        title:       raw.title,
        description: raw.description ?? '',
        startDate,
        endDate:     null,
        time:        normalizeTime(raw.time),
        location: {
          name:    null,
          address: null,
          city:    'New York',
          lat:     null,
          lng:     null,
        },
        price:       { isFree: null, min: null, max: null, currency: 'USD' },
        categories:  [],
        tags:        [],
        organizer:   null,
        attendance:  null,
        ticketUrl:   eventUrl !== PAGE_URL ? eventUrl : null,
        images:      [],
        rawText:     null,
        neighborhood: NEIGHBORHOOD,
        borough:     BOROUGH,
      });
    }

    log(`[westsiderag] Mapped ${allEvents.length} events`);

  } catch (err) {
    logError('[westsiderag] Fatal error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, {
      sourceName:    'westsiderag',
      eventsFound:   0,
      eventsNew:     0,
      eventsUpdated: 0,
      errors,
    });
    throw err;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }

  // Upsert outside the browser try/finally so browser is always closed
  try {
    if (allEvents.length > 0) {
      const result = await upsertEvents(allEvents);
      errors.push(...result.errors);
      log(`[westsiderag] Done — ${result.new} new, ${result.updated} updated, ${errors.length} errors`);

      await finishCrawlRun(runId, {
        sourceName:    'westsiderag',
        eventsFound:   allEvents.length,
        eventsNew:     result.new,
        eventsUpdated: result.updated,
        errors,
      });
    } else {
      log('[westsiderag] No events found — finishing with 0');
      await finishCrawlRun(runId, {
        sourceName:    'westsiderag',
        eventsFound:   0,
        eventsNew:     0,
        eventsUpdated: 0,
        errors,
      });
    }
  } catch (err) {
    logError('[westsiderag] Upsert error', err);
    errors.push(err.message);
    await finishCrawlRun(runId, {
      sourceName:    'westsiderag',
      eventsFound:   allEvents.length,
      eventsNew:     0,
      eventsUpdated: 0,
      errors,
    });
    throw err;
  }
}
