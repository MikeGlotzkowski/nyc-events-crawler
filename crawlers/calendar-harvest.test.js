import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The crawler imports lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'calendar-harvest');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

let ch;
before(async () => {
  ch = await import('./calendar-harvest.js');
});

// A generic, verified-shape venue seed (fixture host only — no live network in these tests).
const SEED = {
  name: 'Example Venue',
  url: 'https://events.example.org',
  neighborhood: 'Fort Greene',
  borough: 'Brooklyn',
};

const SCHEMA_KEYS = [
  'attendance', 'borough', 'categories', 'description', 'endDate', 'id',
  'images', 'location', 'neighborhood', 'organizer', 'price', 'rawText',
  'source', 'sourceUrl', 'startDate', 'tags', 'ticketUrl', 'time', 'title',
];

// ── Mode 1: WordPress iCal ───────────────────────────────────────

describe('calendar-harvest iCal mode', () => {
  it('parses a VCALENDAR fixture into events', () => {
    const events = ch.parseIcalBody(read('wordpress.ics'), SEED);
    assert.ok(events.length >= 2, 'expected at least two VEVENTs');

    const walk = events.find(e => e.title === 'Harvest Walk & Birding');
    assert.ok(walk, 'timed event missing');
    assert.equal(walk.source, 'Example Venue');
    assert.equal(walk.sourceUrl, 'https://events.example.org/events/harvest-walk');
    assert.equal(walk.startDate, '2026-12-01T15:00:00.000Z'); // TZID=UTC read as NYC wall clock
    assert.equal(walk.endDate, '2026-12-01T16:30:00.000Z');
    assert.deepEqual(walk.images, ['https://events.example.org/uploads/harvest-walk.png']);
    assert.ok(walk.tags.includes('ical'));
    assert.match(walk.id, /^[0-9a-f]{16}$/);
  });

  it('keeps the calendar date for an all-day (VALUE=DATE) event', () => {
    const seedSwap = ch.parseIcalBody(read('wordpress.ics'), SEED).find(e => e.title === 'Seed Swap');
    assert.ok(seedSwap);
    assert.equal(seedSwap.startDate, '2026-12-02');
    assert.equal(seedSwap.endDate, '2026-12-03');
  });

  it('REJECTS an HTML body served from ?ical=1 (does not parse it as events)', () => {
    assert.equal(ch.isIcal(read('wordpress.ics')), true);
    assert.equal(ch.isIcal(read('ical-html.html')), false);
    assert.deepEqual(ch.parseIcalBody(read('ical-html.html'), SEED), []);
  });

  it('emits the shared event schema', () => {
    for (const e of ch.parseIcalBody(read('wordpress.ics'), SEED)) {
      assert.deepEqual(Object.keys(e).sort(), SCHEMA_KEYS);
    }
  });
});

// ── Mode 4: JSON-LD Event ────────────────────────────────────────

describe('calendar-harvest JSON-LD mode', () => {
  it('extracts an Event from a @graph block', () => {
    const events = ch.extractJsonLdEvents(read('jsonld-graph.html'), SEED, 'https://events.example.org/events');
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.title, 'Winter Concert');
    assert.equal(e.sourceUrl, 'https://events.example.org/events/winter-concert');
    assert.equal(e.startDate, '2026-12-05T19:30:00-05:00');
    assert.equal(e.endDate, '2026-12-05T21:00:00-05:00');
    assert.equal(e.location.name, 'Main Hall');
    assert.equal(e.location.address, '1 Main St, Brooklyn, NY 11201');
    assert.deepEqual(e.price, { isFree: false, min: 25, max: 25, currency: 'USD' });
    assert.deepEqual(e.images, ['https://events.example.org/uploads/winter-concert.jpg']);
    assert.deepEqual(e.categories, ['Event']);
    assert.ok(e.tags.includes('jsonld'));
    assert.match(e.id, /^[0-9a-f]{16}$/);
  });

  it('extracts an Event from a bare-array block', () => {
    const events = ch.extractJsonLdEvents(read('jsonld-array.html'), SEED, 'https://events.example.org/events');
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.title, 'Gallery Opening');
    assert.equal(e.startDate, '2026-12-10T18:00:00-05:00');
    assert.equal(e.location.name, 'The Gallery');
    assert.deepEqual(e.price, { isFree: true, min: 0, max: 0, currency: 'USD' });
  });

  it('skips a malformed page without throwing', () => {
    assert.deepEqual(ch.extractJsonLdEvents(read('malformed.html'), SEED, 'https://events.example.org/contact'), []);
    assert.deepEqual(ch.extractJsonLdEvents('<script type="application/ld+json">{oops</script>', SEED, 'https://x.test'), []);
    assert.deepEqual(ch.extractJsonLdEvents('', SEED, 'https://x.test'), []);
    assert.deepEqual(ch.extractJsonLdEvents(null, SEED, 'https://x.test'), []);
  });
});

// ── Mode 3: sitemap ──────────────────────────────────────────────

describe('calendar-harvest sitemap mode', () => {
  it('discovers event URLs and ignores the rest of the sitemap', () => {
    const urls = ch.eventUrlsFromSitemap(read('sitemap.xml'));
    assert.deepEqual(urls.sort(), [
      'https://events.example.org/calendar/winter-concert',
      'https://events.example.org/event/seed-swap/',
      'https://events.example.org/events/harvest-walk',
    ].sort());
  });

  it('returns nothing for a non-sitemap body', () => {
    assert.deepEqual(ch.eventUrlsFromSitemap(read('ical-html.html')), []);
    assert.deepEqual(ch.eventUrlsFromSitemap(''), []);
  });
});

// ── Mode 3 addendum: sitemap INDEX → child sitemaps ──────────────
//
// Modern WordPress (Yoast/RankMath, The Events Calendar) serve /sitemap.xml as a
// sitemap INDEX whose <loc> entries are CHILD sitemaps; the event URLs live inside
// the child (e.g. BRIC Arts Media → /event-sitemap.xml → 471 event URLs).
// The old code kept only /event//calendar/ URLs, so an index yielded ZERO events.

describe('calendar-harvest sitemap-index mode', () => {
  it('detects a sitemap index (vs a urlset)', () => {
    assert.equal(ch.isSitemapIndex(read('sitemap-index.xml')), true);
    assert.equal(ch.isSitemapIndex(read('sitemap-index-nested.xml')), true);
    assert.equal(ch.isSitemapIndex(read('sitemap.xml')), false);
    assert.equal(ch.isSitemapIndex(read('ical-html.html')), false);
    assert.equal(ch.isSitemapIndex(''), false);
  });

  it('(a) an index yields the EVENT child sitemap(s) to follow, not zero events', () => {
    assert.deepEqual(
      ch.eventChildSitemapsFromIndex(read('sitemap-index.xml')),
      ['https://events.example.org/event-sitemap.xml'],
    );
  });

  it('(b) a child URL set yields its event page URLs', () => {
    assert.deepEqual(ch.eventUrlsFromSitemap(read('event-sitemap.xml')).sort(), [
      'https://events.example.org/calendar/winter-concert',
      'https://events.example.org/event/seed-swap/',
      'https://events.example.org/events/harvest-walk',
    ].sort());
  });

  it('(c) non-event children (page/news/podcast) are NOT followed', () => {
    const children = ch.eventChildSitemapsFromIndex(read('sitemap-index.xml'));
    for (const noise of ['page-sitemap.xml', 'news-sitemap.xml', 'podcast-sitemap.xml']) {
      assert.ok(!children.some(u => u.endsWith(noise)), `${noise} must be filtered out`);
    }
  });

  it('(d) recursion is capped at one level and loop-safe', async () => {
    const calls = [];
    const fetchText = async (url) => {
      calls.push(url);
      if (url.endsWith('/sitemap.xml')) return { ok: true, status: 200, contentType: 'application/xml', body: read('sitemap-index-nested.xml') };
      if (url.endsWith('/events-index.xml')) return { ok: true, status: 200, contentType: 'application/xml', body: read('events-index.xml') };
      return { ok: false, status: 404, contentType: 'text/plain', body: 'not found' };
    };
    const events = await ch.harvestSeed(SEED, { fetchText, domainDelayMs: 0 });
    assert.deepEqual(events, []);
    assert.equal(calls.filter(u => u.endsWith('/sitemap.xml')).length, 1, 'root sitemap fetched once (no loop)');
    assert.equal(calls.filter(u => u.endsWith('/events-index.xml')).length, 1, 'first-level child fetched once');
    assert.ok(!calls.some(u => u.endsWith('/event-sitemap.xml')), 'must NOT descend into a nested index (cap = 1 level)');
  });
});

// ── Mode 5: __NEXT_DATA__ ────────────────────────────────────────

describe('calendar-harvest __NEXT_DATA__ mode', () => {
  it('best-effort extracts event-ish objects', () => {
    const events = ch.extractNextDataEvents(read('next.html'), SEED, 'https://nextvenue.example.org/events');
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.title, 'Next.js Warehouse Show');
    assert.equal(e.startDate, '2026-12-12T20:00:00-05:00');
    assert.equal(e.sourceUrl, 'https://nextvenue.example.org/events/warehouse-show');
    assert.deepEqual(e.images, ['https://nextvenue.example.org/uploads/warehouse.jpg']);
    assert.equal(e.location.name, 'The Warehouse');
  });

  it('returns nothing when there is no __NEXT_DATA__', () => {
    assert.deepEqual(ch.extractNextDataEvents(read('malformed.html'), SEED, 'https://x.test'), []);
  });
});

// ── Seed discovery (stubbed fetch) ───────────────────────────────

describe('calendar-harvest seed discovery', () => {
  it('prefers WordPress iCal and never reaches REST when it is a real feed', async () => {
    const calls = [];
    const fetchText = async (url) => {
      calls.push(url);
      if (url.startsWith('https://events.example.org/?ical=1')) {
        return { ok: true, status: 200, contentType: 'text/calendar', body: read('wordpress.ics') };
      }
      return { ok: false, status: 404, contentType: 'text/plain', body: 'not found' };
    };
    const events = await ch.harvestSeed(SEED, { fetchText, domainDelayMs: 0 });
    assert.ok(events.length >= 2);
    assert.ok(calls[0].includes('ical=1'), 'iCal must be tried first');
    for (const e of events) assert.equal(e.source, 'Example Venue');
  });

  it('falls through to sitemap + JSON-LD when ?ical=1 returns HTML', async () => {
    const fetchText = async (url) => {
      if (url.includes('ical=1')) return { ok: true, status: 200, contentType: 'text/html', body: read('ical-html.html') };
      if (url.includes('/wp-json/tribe/events/v1/events')) return { ok: false, status: 404, contentType: 'application/json', body: '{}' };
      if (url.endsWith('/sitemap.xml')) return { ok: true, status: 200, contentType: 'application/xml', body: read('sitemap.xml') };
      if (url === 'https://events.example.org/events/harvest-walk') {
        return { ok: true, status: 200, contentType: 'text/html', body: read('jsonld-graph.html') };
      }
      return { ok: true, status: 200, contentType: 'text/html', body: read('malformed.html') };
    };
    const events = await ch.harvestSeed(SEED, { fetchText, domainDelayMs: 0 });
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'Winter Concert');
  });

  it('skips a seed whose fetch throws — never fails the run', async () => {
    const fetchText = async () => { throw new Error('boom'); };
    assert.deepEqual(await ch.harvestSeed(SEED, { fetchText, domainDelayMs: 0 }), []);
  });

  it('follows a BRIC-shaped sitemap index into its child event sitemap and harvests JSON-LD', async () => {
    const calls = [];
    const fetchText = async (url) => {
      calls.push(url);
      if (url.includes('ical=1')) return { ok: false, status: 404, contentType: 'text/plain', body: 'not found' };
      if (url.includes('/wp-json/tribe/events/v1/events')) return { ok: false, status: 404, contentType: 'application/json', body: '{}' };
      if (url.endsWith('/sitemap.xml')) return { ok: true, status: 200, contentType: 'application/xml', body: read('sitemap-index.xml') };
      if (url.endsWith('/event-sitemap.xml')) return { ok: true, status: 200, contentType: 'application/xml', body: read('event-sitemap.xml') };
      if (url === 'https://events.example.org/event/seed-swap/') {
        return { ok: true, status: 200, contentType: 'text/html', body: read('jsonld-graph.html') };
      }
      return { ok: true, status: 200, contentType: 'text/html', body: read('malformed.html') };
    };
    const events = await ch.harvestSeed(SEED, { fetchText, domainDelayMs: 0 });
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'Winter Concert');
    assert.ok(calls.includes('https://events.example.org/event-sitemap.xml'), 'child event sitemap was followed');
    assert.ok(!calls.some(u => u.endsWith('/page-sitemap.xml')), 'noise child sitemaps are never fetched');
  });
});

// ── Registry ─────────────────────────────────────────────────────

describe('calendar-harvest CALENDAR_SEEDS', () => {
  it('ships 5-10 unique, well-formed https seeds with area metadata', () => {
    assert.ok(Array.isArray(ch.CALENDAR_SEEDS));
    assert.ok(ch.CALENDAR_SEEDS.length >= 5 && ch.CALENDAR_SEEDS.length <= 10);
    for (const s of ch.CALENDAR_SEEDS) {
      assert.ok(s.name, 'seed needs a name');
      assert.match(s.url, /^https:\/\//, `seed ${s.name} url must be https`);
      assert.ok(s.borough, `seed ${s.name} needs a borough`);
    }
    const urls = ch.CALENDAR_SEEDS.map(s => s.url);
    assert.equal(new Set(urls).size, urls.length, 'seed URLs must be unique');
  });
});
