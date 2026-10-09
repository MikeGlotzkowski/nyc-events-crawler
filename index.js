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
 *   calendar-harvest Generic calendar/JSON-LD harvester over a venue seed list
 *   riverside-park   Riverside Park WordPress Events Calendar
 *   westsiderag      West Side Rag weekly events page (Playwright)
 *   nyccom           NYC.com multi-category Playwright crawler
 *   seatgeek         SeatGeek Platform API (active — uses SEATGEEK_CLIENT_ID)
  brooklyn-library   Brooklyn Public Library events (local only: Cloudflare blocks CI runners)
  queens-library     Queens Public Library events (calendar pages)
  van-cortlandt-park Van Cortlandt Park Alliance (Events Calendar REST)
  forest-park        Forest Park Trust (Squarespace JSON)
 *   brooklyn-library   Brooklyn Public Library events (local only: Cloudflare blocks CI runners)
  queens-library     Queens Public Library events (calendar pages)
  van-cortlandt-park Van Cortlandt Park Alliance (Events Calendar REST)
  forest-park        Forest Park Trust (Squarespace JSON)
  calendar-harvest   Generic calendar/JSON-LD harvester (venue seed list)
 *   whitney            Whitney Museum (JSON API)
 *   bam                BAM, Brooklyn Academy of Music (calendar JSON)
 *   lincoln-center     Lincoln Center, all resident organizations (calendar JSON)
 *   carnegie-hall      Carnegie Hall (sitemap; pages are behind a waiting room)
 *   resident-advisor   Resident Advisor club nights (GraphQL)
 *   dice               DICE shows and parties (browse pages)
 *   timeout            Time Out New York's weekend list (LLM extraction)
 *   ticketmaster       Ticketmaster Discovery API (requires TICKETMASTER_API_KEY)
 *   all-tier1        every non-Playwright crawler above except brooklyn-library (local-only)
 *   all-tier2        westsiderag, nyccom (Playwright-based)
 *   all              all crawlers
 */

import { loadEnv } from './env-loader.js';
import { log, logError, ensureConfigAndCheckEnabled } from './lib/base-crawler.js';
import { resolveTarget } from './lib/cli-args.js';

loadEnv();

// ── Crawler registry ─────────────────────────────────────────────────────────

const CRAWLERS = {
  'nyc-parks':      () => import('./crawlers/nyc-parks.js').then(m => m.crawl),
  'nyc-opendata':   () => import('./crawlers/nyc-opendata.js').then(m => m.crawl),
  'rss-blogs':      () => import('./crawlers/rss-blogs.js').then(m => m.crawl),
  'ical-feeds':     () => import('./crawlers/ical-feeds.js').then(m => m.crawl),
  'calendar-harvest': () => import('./crawlers/calendar-harvest.js').then(m => m.crawl),
  'riverside-park': () => import('./crawlers/riverside-park.js').then(m => m.crawl),
  'westsiderag':    () => import('./crawlers/westsiderag.js').then(m => m.crawl),
  'nyccom':         () => import('./crawlers/nyccom.js').then(m => m.crawl),
  'seatgeek':       () => import('./crawlers/seatgeek.js').then(m => m.crawl),
  'brooklyn-library':   () => import('./crawlers/brooklyn-library.js').then(m => m.crawl),
  'queens-library':     () => import('./crawlers/queens-library.js').then(m => m.crawl),
  'van-cortlandt-park': () => import('./crawlers/van-cortlandt-park.js').then(m => m.crawl),
  'forest-park':        () => import('./crawlers/forest-park.js').then(m => m.crawl),
  'whitney':            () => import('./crawlers/whitney.js').then(m => m.crawl),
  'bam':                () => import('./crawlers/bam.js').then(m => m.crawl),
  'lincoln-center':     () => import('./crawlers/lincoln-center.js').then(m => m.crawl),
  'carnegie-hall':      () => import('./crawlers/carnegie-hall.js').then(m => m.crawl),
  'resident-advisor':   () => import('./crawlers/resident-advisor.js').then(m => m.crawl),
  'dice':               () => import('./crawlers/dice.js').then(m => m.crawl),
  'timeout':            () => import('./crawlers/timeout.js').then(m => m.crawl),
  'ticketmaster':       () => import('./crawlers/ticketmaster.js').then(m => m.crawl),
};

const failed = [];

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
    failed.push(name);
  }
}

async function runAll(names) {
  for (const name of names) {
    await runCrawler(name);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

const arg = process.argv[2];
const action = resolveTarget(arg);

const USAGE = `
NYC Events Crawler

Usage: node index.js <target>

Targets:
  nyc-parks        NYC Parks RSS feed
  nyc-opendata     NYC Open Data (Socrata): permitted events + parks events
  rss-blogs        Neighborhood blog RSS + LLM (25 sources)
  ical-feeds       Museum/library/venue iCal feeds
  calendar-harvest Generic calendar/JSON-LD harvester over a venue seed list
  riverside-park   Riverside Park WordPress Events Calendar
  westsiderag      West Side Rag weekly events (Playwright)
  nyccom           NYC.com multi-category crawler (Playwright)
  seatgeek         SeatGeek Platform API (active — uses SEATGEEK_CLIENT_ID)
  brooklyn-library   Brooklyn Public Library events (local only: Cloudflare blocks CI runners)
  queens-library     Queens Public Library events (calendar pages)
  van-cortlandt-park Van Cortlandt Park Alliance (Events Calendar REST)
  forest-park        Forest Park Trust (Squarespace JSON)
  whitney            Whitney Museum (JSON API)
  bam                BAM, Brooklyn Academy of Music (calendar JSON)
  lincoln-center     Lincoln Center, all resident organizations (calendar JSON)
  carnegie-hall      Carnegie Hall (sitemap; pages are behind a waiting room)
  ticketmaster       Ticketmaster Discovery API (requires TICKETMASTER_API_KEY)
  all-tier1        Run every non-Playwright crawler except brooklyn-library (local-only)
  all-tier2        Run: westsiderag, nyccom
  all              Run all crawlers
`.trim();

switch (action.kind) {
  case 'usage':
    console.log(USAGE);
    process.exit(0);
    break;
  case 'all':
    await runAll(action.targets);
    break;
  case 'crawler':
    await runCrawler(action.name);
    break;
  case 'unknown':
    console.error(`Unknown target: "${action.name}"\n`);
    console.log(USAGE);
    process.exit(1);
}

if (failed.length > 0) {
  logError(`${failed.length} crawler(s) failed: ${failed.join(', ')}`);
  process.exit(1);
}
