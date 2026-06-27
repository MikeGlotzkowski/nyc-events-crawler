/**
 * NYC Events Crawler — Multi-source runner
 *
 * Usage:
 *   node index.js <crawler>
 *
 * Available crawlers:
 *   nyc-parks        NYC Parks RSS feed
 *   nyc-opendata     NYC Open Data (Socrata): permitted events + parks events
 *   rss-blogs        Neighborhood blog RSS + LLM extraction (25 sources)
 *   ical-feeds       Museum/library/venue iCal (.ics) feeds
 *   riverside-park   Riverside Park WordPress Events Calendar
 *   westsiderag      West Side Rag weekly events page (Playwright)
 *   nyccom           NYC.com multi-category Playwright crawler
 *   seatgeek         SeatGeek Platform API (dormant — requires SEATGEEK_CLIENT_ID)
 *   all-tier1        nyc-parks, nyc-opendata, ical-feeds, riverside-park, rss-blogs (no Playwright)
 *   all-tier2        westsiderag, nyccom (Playwright-based)
 *   all              all crawlers
 */

import { loadEnv } from './env-loader.js';
import { log, logError, ensureConfigAndCheckEnabled } from './lib/base-crawler.js';

loadEnv();

// ── Crawler registry ─────────────────────────────────────────────────────────

const CRAWLERS = {
  'nyc-parks':      () => import('./crawlers/nyc-parks.js').then(m => m.crawl),
  'nyc-opendata':   () => import('./crawlers/nyc-opendata.js').then(m => m.crawl),
  'rss-blogs':      () => import('./crawlers/rss-blogs.js').then(m => m.crawl),
  'ical-feeds':     () => import('./crawlers/ical-feeds.js').then(m => m.crawl),
  'riverside-park': () => import('./crawlers/riverside-park.js').then(m => m.crawl),
  'westsiderag':    () => import('./crawlers/westsiderag.js').then(m => m.crawl),
  'nyccom':         () => import('./crawlers/nyccom.js').then(m => m.crawl),
  'seatgeek':       () => import('./crawlers/seatgeek.js').then(m => m.crawl),
};

const TIER1 = ['nyc-parks', 'nyc-opendata', 'ical-feeds', 'riverside-park', 'rss-blogs'];
const TIER2 = ['westsiderag', 'nyccom'];
const ALL   = [...TIER1, ...TIER2];

// ── Runner ───────────────────────────────────────────────────────────────────

async function runCrawler(name) {
  log(`\n${'─'.repeat(60)}`);
  log(`Starting crawler: ${name}`);
  log(`${'─'.repeat(60)}`);
  try {
    const getCrawl = CRAWLERS[name];
    if (!getCrawl) throw new Error(`Unknown crawler: ${name}`);

    const enabled = await ensureConfigAndCheckEnabled(name);
    if (!enabled) {
      log(`⏭️  Crawler disabled in crawler_config: ${name} — skipping`);
      return;
    }

    const crawlFn = await getCrawl();
    await crawlFn();
    log(`✅ Crawler finished: ${name}`);
  } catch (err) {
    logError(`Crawler failed: ${name}`, err);
  }
}

async function runAll(names) {
  for (const name of names) {
    await runCrawler(name);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

const arg = process.argv[2];

const USAGE = `
NYC Events Crawler

Usage: node index.js <target>

Targets:
  nyc-parks        NYC Parks RSS feed
  nyc-opendata     NYC Open Data (Socrata): permitted events + parks events
  rss-blogs        Neighborhood blog RSS + LLM (25 sources)
  ical-feeds       Museum/library/venue iCal feeds
  riverside-park   Riverside Park WordPress Events Calendar
  westsiderag      West Side Rag weekly events (Playwright)
  nyccom           NYC.com multi-category crawler (Playwright)
  seatgeek         SeatGeek Platform API (dormant — requires SEATGEEK_CLIENT_ID)
  all-tier1        Run: nyc-parks, nyc-opendata, ical-feeds, riverside-park, rss-blogs
  all-tier2        Run: westsiderag, nyccom
  all              Run all crawlers
`.trim();

if (!arg) {
  console.log(USAGE);
  process.exit(0);
}

switch (arg) {
  case 'all-tier1':
    await runAll(TIER1);
    break;
  case 'all-tier2':
    await runAll(TIER2);
    break;
  case 'all':
    await runAll(ALL);
    break;
  default:
    if (CRAWLERS[arg]) {
      await runCrawler(arg);
    } else {
      console.error(`Unknown target: "${arg}"\n`);
      console.log(USAGE);
      process.exit(1);
    }
}
