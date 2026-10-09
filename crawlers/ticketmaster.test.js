import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The crawler imports lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

// Real response, recorded live 2026-10-09 (truncated to 5 events; see fixtures/ticketmaster/).
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../fixtures/ticketmaster/windows-1.json', import.meta.url), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(new URL('../fixtures/ticketmaster/manifest.json', import.meta.url), 'utf8'));
const byName = (n) => FIXTURE._embedded.events.find((e) => e.name === n);

let tm;
before(async () => { tm = await import('./ticketmaster.js'); });

describe('ticketmaster mapEvent', () => {
  it('maps a timed Music/Jazz event to the shared event shape', () => {
    const e = tm.mapEvent(byName('Thelonious Monk Birthday Celebration'));

    assert.equal(e.source, 'Ticketmaster');
    assert.equal(e.organizer, 'Ticketmaster');
    assert.equal(e.title, 'Thelonious Monk Birthday Celebration');
    assert.equal(e.startDate, '2026-10-09T23:00:00Z'); // dates.start.dateTime is a real instant
    assert.equal(e.endDate, '2026-10-10T00:15:00Z');
    assert.equal(e.time, null); // left to upsert's nyc-time normalization
    assert.equal(e.ticketUrl, 'https://www.ticketweb.com/event/thelonious-monk-birthday-celebration-birdland-theater-tickets/14928283');
    assert.equal(e.sourceUrl, e.ticketUrl);
    assert.deepEqual(e.categories, ['Music', 'Jazz']); // segment + genre
    assert.deepEqual(e.tags, ['ticketmaster']);
    assert.deepEqual(e.price, { isFree: false, min: 35.46, max: 45.76, currency: 'USD' });

    assert.equal(e.location.name, 'Birdland Theater');
    assert.equal(e.location.address, '315 West 44th Street, New York NY 10036');
    assert.equal(e.location.city, 'New York');
    assert.ok(Math.abs(e.location.lat - 40.7590167) < 1e-6);
    assert.ok(Math.abs(e.location.lng + 73.9896861) < 1e-6);

    assert.equal(e.neighborhood, 'Midtown');
    assert.equal(e.borough, 'Manhattan');
    assert.equal(e.id.length, 16);

    // images: one entry, the largest 16_9 (2048×1152), not a 3_2 crop
    assert.equal(e.images.length, 1);
    assert.ok(e.images[0].endsWith('TABLET_LANDSCAPE_LARGE_16_9.jpg'));

    // description combines info + pleaseNote
    assert.ok(e.description.includes('Uri Caine'));
    assert.ok(e.description.includes('Ages 10+'));
  });

  it('maps a zero-price listing as free', () => {
    const e = tm.mapEvent(byName('Birdland Big Band'));
    assert.deepEqual(e.price, { isFree: true, min: 0, max: 0, currency: 'USD' });
    assert.deepEqual(e.categories, ['Music', 'Jazz']);
    assert.equal(e.startDate, '2026-10-09T21:30:00Z');
  });

  it('maps a priced event and an Arts & Theatre event without a price range', () => {
    const paid = tm.mapEvent(byName('Adam Paddock'));
    assert.deepEqual(paid.price, { isFree: false, min: 20.07, max: 20.07, currency: 'USD' });
    assert.deepEqual(paid.categories, ['Music', 'Alternative']);
    assert.ok(paid.description.startsWith('This event is 21 and over'));

    const arts = tm.mapEvent(byName('Banksy Museum - Flexiticket'));
    assert.deepEqual(arts.categories, ['Arts & Theatre', 'Fine Art']);
    assert.deepEqual(arts.price, { isFree: false, min: null, max: null, currency: 'USD' });
    assert.equal(arts.neighborhood, 'Tribeca');
  });

  it('handles a date-only event (no start time)', () => {
    const e = tm.mapEvent(byName('Madison Square Garden Tour Experience'));
    assert.equal(e.startDate, '2026-10-09'); // localDate, no time
    assert.equal(e.time, null);
    assert.equal(e.endDate, null);
    assert.deepEqual(e.categories, ['Miscellaneous']);
    assert.ok(e.description.startsWith('PLEASE NOTE:'));
    assert.equal(e.location.name, 'Madison Square Garden');
  });

  it('drops items without a name or a start date', () => {
    assert.equal(tm.mapEvent({}), null);
    assert.equal(tm.mapEvent({ name: '  ', dates: { start: { dateTime: '2026-10-09T12:00:00Z' } } }), null);
    assert.equal(tm.mapEvent({ name: 'No Date' }), null);
    assert.equal(tm.mapEvent({ name: 'Bad Date', dates: { start: { dateTime: 'not-a-date' } } }), null);
  });

  it('attributes every listing to Ticketmaster with its event link', () => {
    for (const raw of FIXTURE._embedded.events) {
      const e = tm.mapEvent(raw);
      assert.equal(e.source, 'Ticketmaster');
      assert.equal(e.rawText, tm.ATTRIBUTION);
      assert.match(tm.ATTRIBUTION, /Ticketmaster/);
      assert.equal(e.ticketUrl, raw.url);
    }
  });
});

describe('ticketmaster image and description helpers', () => {
  it('prefers a 16_9 image over a larger image of another ratio', () => {
    const chosen = tm.pickImage([
      { ratio: '3_2', url: 'https://img/3_2-big.jpg', width: 4096, height: 2730 },
      { ratio: '16_9', url: 'https://img/16_9-small.jpg', width: 1024, height: 576 },
    ]);
    assert.equal(chosen, 'https://img/16_9-small.jpg');
  });

  it('picks the largest 16_9 and falls back to the largest of any ratio', () => {
    assert.equal(tm.pickImage([
      { ratio: '16_9', url: 'https://img/a.jpg', width: 640 },
      { ratio: '16_9', url: 'https://img/b.jpg', width: 2048 },
    ]), 'https://img/b.jpg');
    assert.equal(tm.pickImage([{ ratio: '3_2', url: 'https://img/only.jpg', width: 305 }]), 'https://img/only.jpg');
    assert.equal(tm.pickImage([]), null);
    assert.equal(tm.pickImage(undefined), null);
  });

  it('joins info and pleaseNote, dropping blanks', () => {
    assert.equal(tm.buildDescription({ info: 'Info.', pleaseNote: 'Note.' }), 'Info.\n\nNote.');
    assert.equal(tm.buildDescription({ info: '  ', pleaseNote: 'Note.' }), 'Note.');
    assert.equal(tm.buildDescription({}), '');
  });
});

describe('ticketmaster pagination windows', () => {
  const NOW = new Date('2026-10-09T12:00:00.000Z');

  it('never lets a requested page reach the deep-paging cap (size*page < 1000)', async () => {
    const pages = [];
    const fetchImpl = async (url) => {
      const p = Number(new URL(url).searchParams.get('page'));
      pages.push(p);
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({
          page: { size: tm.SIZE, totalPages: 9999, number: p },
          _embedded: { events: [{ id: `x${p}`, name: `e${p}`, dates: { start: { dateTime: '2026-10-09T12:00:00Z' } } }] },
        }),
      };
    };
    await tm.fetchWindow({ apiKey: 'k', startDateTime: 'a', endDateTime: 'b', fetchImpl, sleepImpl: async () => {} });

    assert.ok(pages.length > 0);
    for (const p of pages) assert.ok(tm.SIZE * p < 1000, `requested page ${p} exceeds the 1000-item cap`);
    assert.equal(pages.length, tm.MAX_PAGES_PER_WINDOW);
  });

  it('stops paging once page.totalPages is reached', async () => {
    const pages = [];
    const fetchImpl = async (url) => {
      const p = Number(new URL(url).searchParams.get('page'));
      pages.push(p);
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({
          page: { size: tm.SIZE, totalPages: 1, number: p },
          _embedded: { events: [{ id: `x${p}`, name: `e${p}`, dates: { start: { dateTime: '2026-10-09T12:00:00Z' } } }] },
        }),
      };
    };
    const evs = await tm.fetchWindow({ apiKey: 'k', startDateTime: 'a', endDateTime: 'b', fetchImpl, sleepImpl: async () => {} });
    assert.deepEqual(pages, [0]);
    assert.equal(evs.length, 1);
  });

  it('splits the forward window into chunks of at most CHUNK_DAYS', () => {
    const ranges = tm.windowRanges(NOW, 60, 3);
    assert.equal(ranges.length, 20); // 60 days / 3-day chunks
    assert.equal(ranges[0].start.toISOString(), '2026-10-09T12:00:00.000Z');
    assert.equal(ranges.at(-1).end.toISOString(), '2026-12-08T12:00:00.000Z');
    let prevEnd = null;
    for (const r of ranges) {
      const days = (r.end - r.start) / 86400000;
      assert.ok(days <= 3, 'window longer than CHUNK_DAYS');
      if (prevEnd) assert.equal(r.start.getTime(), prevEnd);
      prevEnd = r.end.getTime();
    }
  });

  it('builds the exact request URL the fixture was recorded with', () => {
    const ranges = tm.windowRanges(NOW, 60, 3);
    const url = tm.buildPageUrl({
      apiKey: 'fixture-key',
      startDateTime: tm.isoSeconds(ranges[0].start),
      endDateTime: tm.isoSeconds(ranges[0].end),
      page: 0,
    });
    assert.equal(url, Object.keys(MANIFEST.responses)[0]);
    assert.match(url, /latlong=40\.7128/);   // latlong+radius: also picks up Brooklyn/Bronx venues
    assert.match(url, /radius=25/);
    assert.match(url, /stateCode=NY/);
    assert.match(url, /size=200/);
    assert.doesNotMatch(url, /[?&]city=/);
    assert.ok(tm.SIZE <= 200);
  });
});

describe('ticketmaster rate limiting', () => {
  it('backs off and retries on 429 instead of throwing', async () => {
    const calls = [];
    let n = 0;
    const fetchImpl = async () => {
      calls.push(++n);
      if (n === 1) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ page: { size: 200, totalPages: 0, number: 0 }, _embedded: { events: [] } }),
      };
    };
    const slept = [];
    const events = await tm.fetchWindow({
      apiKey: 'k', startDateTime: 'a', endDateTime: 'b',
      fetchImpl, sleepImpl: async (ms) => { slept.push(ms); },
    });
    assert.equal(n, 2);                    // retried once
    assert.deepEqual(events, []);          // resolved, did not throw
    assert.deepEqual(slept, [tm.MIN_BACKOFF_MS]);
  });

  it('derives the backoff from Rate-Limit-Reset when present, else exponential', () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3);
    const fromHeader = tm.retryDelayMs({ headers: { get: (h) => (h === 'Rate-Limit-Reset' ? reset : null) } }, 1);
    assert.ok(fromHeader > 2000 && fromHeader <= 3000, `expected ~3s, got ${fromHeader}`);

    const none = { headers: { get: () => null } };
    assert.equal(tm.retryDelayMs(none, 1), tm.MIN_BACKOFF_MS);
    assert.equal(tm.retryDelayMs(none, 2), tm.MIN_BACKOFF_MS * 2);
    assert.equal(tm.retryDelayMs(none, 20), tm.MAX_BACKOFF_MS);
  });
});

describe('ticketmaster crawl', () => {
  it('no-ops cleanly when TICKETMASTER_API_KEY is unset (never touches the network)', async () => {
    const saved = process.env.TICKETMASTER_API_KEY;
    delete process.env.TICKETMASTER_API_KEY;
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('network used without a key'); };
    try {
      await tm.crawl(); // must resolve without throwing
    } finally {
      globalThis.fetch = realFetch;
      if (saved !== undefined) process.env.TICKETMASTER_API_KEY = saved;
    }
  });
});
