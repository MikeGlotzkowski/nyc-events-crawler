import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The crawler imports lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

import { normalizeEventDates } from '../lib/nyc-time.js';

// Real response, recorded live 2026-10-09 from
// https://api.seatgeek.com/2/events?lat=40.7128&lon=-74.0060&range=25mi&per_page=5&sort=datetime_local.asc
// (client_id scrubbed from the saved body — see fixtures/seatgeek/).
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../fixtures/seatgeek/nyc-5.json', import.meta.url), 'utf8'));
const byTitle = (t) => FIXTURE.events.find((e) => e.title === t);

let sg;
before(async () => { sg = await import('./seatgeek.js'); });

describe('seatgeek mapEvent', () => {
  it('maps a live concert to the shared event shape', () => {
    const raw = byTitle('DJ Pauly D');
    const e = sg.mapEvent(raw);

    assert.equal(e.source, 'SeatGeek');
    assert.equal(e.title, 'DJ Pauly D');
    // The mapper passes SeatGeek's NYC wall-clock string straight through; base-crawler
    // (normalizeEventDates) turns it into the real instant. datetime_local 18:00 EDT
    // is 22:00Z — never 18:00Z.
    assert.equal(e.startDate, '2026-10-09T18:00:00');
    assert.equal(e.endDate, null);
    assert.equal(e.time, null);
    assert.equal(
      normalizeEventDates(e.startDate, e.time, e.endDate).startAt,
      '2026-10-09T22:00:00.000Z',
    );

    assert.equal(e.location.name, 'The Rooftop at Pier 17');
    assert.equal(e.location.address, '89 South Street, New York, NY 10038');
    assert.equal(e.location.city, 'New York');
    assert.equal(e.location.lat, 40.7063);
    assert.equal(e.location.lng, -74.0038);
    assert.equal(e.borough, 'Manhattan');
    assert.equal(e.neighborhood, 'Financial District');

    assert.equal(e.ticketUrl, 'https://seatgeek.com/dj-pauly-d-tickets/new-york-new-york-the-rooftop-at-pier-17-2026-10-09-6-pm/concert/18282946');
    assert.equal(e.sourceUrl, e.ticketUrl);
    assert.equal(e.organizer, null);
    assert.deepEqual(e.categories, ['concert']); // SeatGeek type, verbatim
    assert.deepEqual(e.tags, ['seatgeek', 'ticketed']);
    assert.deepEqual(e.images, []); // no performer.image on the live payload
    assert.match(e.id, /^[0-9a-f]{16}$/);

    // FLAG: price is never populated by the live API with this key. SeatGeek docs put the
    // numbers under stats.lowest_price/highest_price (which the mapper reads correctly),
    // but every probed event returns `stats: {}`, so the mapper degrades to all-null.
    assert.deepEqual(e.price, { isFree: false, min: null, max: null, currency: 'USD' });
    assert.equal(e.attendance, null); // stats.listing_count, likewise empty
  });

  it('maps a theater event to its own venue and neighborhood', () => {
    const e = sg.mapEvent(byTitle('Drunk Dracula - New York'));
    assert.equal(e.location.name, 'The Ruby Theatre');
    assert.equal(e.location.address, '35 W 39th St, New York, NY 10018');
    assert.deepEqual(e.categories, ['theater']);
    assert.equal(e.startDate, '2026-10-09T18:00:00'); // 6:00 PM EDT
    assert.equal(normalizeEventDates(e.startDate, null, null).startAt, '2026-10-09T22:00:00.000Z');
    assert.equal(e.neighborhood, 'Midtown');
    assert.equal(e.borough, 'Manhattan');
  });

  it('maps every event in the fixture without dropping any (all have a title)', () => {
    const mapped = FIXTURE.events.map(sg.mapEvent).filter(Boolean);
    assert.equal(mapped.length, 5);
    for (const e of mapped) {
      assert.match(e.id, /^[0-9a-f]{16}$/);
      assert.equal(e.source, 'SeatGeek');
      assert.ok(e.title?.trim());
      assert.ok(e.sourceUrl);
      assert.ok(e.startDate);
      assert.ok(Array.isArray(e.images));
      assert.deepEqual(e.tags, ['seatgeek', 'ticketed']);
    }
  });

  it('leaves price unknown for every live event (stats empty on the current key)', () => {
    for (const raw of FIXTURE.events) {
      assert.deepEqual(raw.stats, {}, `unexpected stats on "${raw.title}"`);
      assert.deepEqual(sg.mapEvent(raw).price, { isFree: false, min: null, max: null, currency: 'USD' });
    }
  });

  it('maps an item missing optional fields without throwing or inventing values', () => {
    const e = sg.mapEvent({ id: 999, title: 'Only Title', datetime_utc: '2026-10-09T22:00:00' });

    assert.equal(e.title, 'Only Title');
    assert.equal(e.sourceUrl, null);
    assert.equal(e.ticketUrl, null);
    assert.equal(e.description, '');
    // datetime_utc has no offset suffix; the mapper marks it as the real UTC instant.
    assert.equal(e.startDate, '2026-10-09T22:00:00Z');
    assert.equal(normalizeEventDates(e.startDate, null, null).startAt, '2026-10-09T22:00:00.000Z');
    assert.equal(e.location.name, null);
    assert.equal(e.location.address, null);
    assert.equal(e.location.lat, null);
    assert.equal(e.location.lng, null);
    assert.equal(e.location.city, 'New York'); // source default, not an invented venue
    assert.deepEqual(e.images, []);
    assert.deepEqual(e.categories, ['Concert']); // default when SeatGeek type is absent
    assert.deepEqual(e.price, { isFree: false, min: null, max: null, currency: 'USD' });
    assert.match(e.id, /^[0-9a-f]{16}$/);
  });

  it('drops items with no title', () => {
    assert.equal(sg.mapEvent({}), null);
    assert.equal(sg.mapEvent({ datetime_local: '2026-10-09T18:00:00' }), null);
    assert.equal(sg.mapEvent({ title: '   ', id: 1 }), null);
  });
});

describe('seatgeek fetchEvents', () => {
  it('builds the NYC geo request URL and returns data.events', async () => {
    let seen;
    const events = await sg.fetchEvents('fake-id', async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({ events: [{ id: 1, title: 'x' }] }) };
    });

    const u = new URL(seen);
    assert.equal(`${u.origin}${u.pathname}`, 'https://api.seatgeek.com/2/events');
    assert.equal(u.searchParams.get('client_id'), 'fake-id');
    assert.equal(u.searchParams.get('lat'), '40.7128');
    // The constant is a JS number, so String(-74.0060) serializes as '-74.006' (trailing
    // zero dropped). Same coordinate; the recorded fixture used the padded '-74.0060'.
    assert.equal(u.searchParams.get('lon'), '-74.006');
    assert.equal(Number(u.searchParams.get('lon')), -74.006);
    assert.equal(u.searchParams.get('range'), '25mi');
    assert.equal(u.searchParams.get('sort'), 'datetime_utc.asc');
    assert.deepEqual(events, [{ id: 1, title: 'x' }]);
  });

  it('never logs the client id (nightly logs are shipped)', async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
      await sg.fetchEvents('super-secret-client-id', async () => ({ ok: true, status: 200, json: async () => ({ events: [] }) }));
    } finally {
      console.log = realLog;
    }
    assert.ok(lines.some((l) => l.includes('[seatgeek] Fetching')), 'expected a Fetching log line');
    assert.ok(lines.every((l) => !l.includes('super-secret-client-id')), 'client id leaked into the log');
  });

  it('throws on a non-200 response instead of silently returning []', async () => {
    await assert.rejects(
      () => sg.fetchEvents('fake-id', async () => ({ ok: false, status: 401, json: async () => ({}) })),
      /HTTP 401/,
    );
  });
});

describe('seatgeek crawl', () => {
  // Assertion: crawl() resolves without throwing, and it never calls fetch —
  // it returns before any network use when the key is absent.
  it('no-ops cleanly when SEATGEEK_CLIENT_ID is unset (never touches the network)', async () => {
    const saved = process.env.SEATGEEK_CLIENT_ID;
    delete process.env.SEATGEEK_CLIENT_ID;
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('network used without a key'); };
    try {
      await sg.crawl(); // must resolve without throwing
    } finally {
      globalThis.fetch = realFetch;
      if (saved !== undefined) process.env.SEATGEEK_CLIENT_ID = saved;
    }
  });
});
