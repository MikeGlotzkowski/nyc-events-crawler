import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// The crawler imports lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

let vcp;
before(async () => {
  vcp = await import('./van-cortlandt-park.js');
});

// Trimmed from sample.tmp.json (tribe/events/v1 payload from vancortlandt.org)
const allDayEvent = {
  id: 10002549,
  url: 'https://vancortlandt.org/event/register-now-for-26-2-in-26/2026-09-30/',
  title: 'Register Now for 26.2 in &#8217;26',
  description: '<div data-testid="text-content">\n<div>\n<p>Hike (or Run or Walk) 26.2 miles in Van Cortlandt Park in 2026!</p>\n</div>\n</div>',
  all_day: true,
  start_date: '2026-09-30 00:00:00',
  start_date_details: { year: '2026', month: '09', day: '30', hour: '00', minutes: '00', seconds: '00' },
  end_date: '2026-09-30 23:59:59',
  cost: '',
  image: { url: 'https://vancortlandt.org/wp-content/uploads/2026/04/Untitled-design-2.jpg' },
  categories: [{ name: 'Hikes', slug: 'hikes' }],
  tags: [],
  venue: [],          // tribe sends [] when an event has no venue attached
};

const timedEvent = {
  id: 10002725,
  url: 'https://vancortlandt.org/event/woodlawn-wednesday-forest-restoration/2026-09-30/',
  title: 'Woodlawn Wednesday: Forest Restoration',
  description: '<p><strong>The Challenge:</strong></p>',
  all_day: false,
  start_date: '2026-09-30 09:00:00',
  start_date_details: { year: '2026', month: '09', day: '30', hour: '09', minutes: '00', seconds: '00' },
  end_date: '2026-09-30 12:00:00',
  end_date_details: { year: '2026', month: '09', day: '30', hour: '12', minutes: '00', seconds: '00' },
  cost: '',
  image: { url: 'https://vancortlandt.org/wp-content/uploads/2023/09/woodlawn-vol-picture.png' },
  categories: [{ name: 'Volunteer', slug: 'volunteer' }],
  tags: [],
  venue: [],
};

// Same tribe/v1 shape, with the venue/cost fields the sample leaves empty
const venueEvent = {
  id: 10002801,
  url: 'https://vancortlandt.org/event/fall-tree-care-day/2026-10-03/',
  title: 'Fall Tree Care Day &#8211; Bronx Park',
  description: '<p>Bring gloves. Meet at the <strong>Midwood</strong> entrance.</p>',
  all_day: false,
  start_date: '2026-10-03 10:00:00',
  end_date: '2026-10-03 13:30:00',
  cost: '$5 suggested donation',
  categories: [{ name: 'Volunteer', slug: 'volunteer' }, { name: 'Hikes', slug: 'hikes' }],
  tags: [],
  venue: {
    venue: 'Van Cortlandt Park — Midwood',
    address: 'Van Cortlandt Park',
    city: 'Bronx',
    state: 'NY',
    zip: '10458',
    geo_lat: '40.897216',
    geo_lng: '-73.886017',
  },
};

describe('van-cortlandt-park mapEvent', () => {
  it('maps an all-day event, decoding entities in the title', () => {
    const e = vcp.mapEvent(allDayEvent);
    assert.equal(e.source, 'Van Cortlandt Park');
    assert.equal(e.organizer, 'Van Cortlandt Park Alliance');
    assert.equal(e.title, "Register Now for 26.2 in '26");
    assert.equal(e.sourceUrl, allDayEvent.url);
    assert.equal(e.ticketUrl, allDayEvent.url);
    assert.equal(e.startDate, '2026-09-30');       // all-day → calendar date only
    assert.equal(e.endDate, '2026-09-30');
    assert.equal(e.time, null);
    assert.equal(e.location.name, 'Van Cortlandt Park'); // venue: [] → fallback name
    assert.equal(e.location.address, null);
    assert.equal(e.location.city, 'New York');
    assert.equal(e.location.lat, null);
    assert.equal(e.location.lng, null);
    assert.deepEqual(e.price, { isFree: true, min: 0, max: 0, currency: 'USD' }); // cost: ''
    assert.deepEqual(e.categories, ['Hikes']);
    assert.deepEqual(e.tags, []);
    assert.deepEqual(e.images, ['https://vancortlandt.org/wp-content/uploads/2026/04/Untitled-design-2.jpg']);
    assert.equal(e.neighborhood, 'Van Cortlandt Park');
    assert.equal(e.borough, 'Bronx');
    assert.equal(e.attendance, null);
    assert.equal(e.rawText, null);
    assert.equal(e.id, vcp.mapEvent(allDayEvent).id);
    assert.match(e.id, /^[0-9a-f]{16}$/);
  });

  it('maps a timed event to NYC wall clock and a display time range', () => {
    const e = vcp.mapEvent(timedEvent);
    assert.equal(e.title, 'Woodlawn Wednesday: Forest Restoration');
    assert.equal(e.startDate, '2026-09-30T09:00:00');
    assert.equal(e.endDate, '2026-09-30T12:00:00');
    assert.equal(e.time, '9:00 AM–12:00 PM');
    assert.deepEqual(e.categories, ['Volunteer']);
    assert.notEqual(e.id, vcp.mapEvent(allDayEvent).id);
  });

  it('strips tags from the description and keeps its text', () => {
    assert.equal(
      vcp.mapEvent(timedEvent).description,
      'The Challenge:',
    );
    assert.match(vcp.mapEvent(venueEvent).description, /^Bring gloves\. Meet at the Midwood entrance\.$/);
  });

  it('maps an attached venue and a non-empty cost', () => {
    const e = vcp.mapEvent(venueEvent);
    assert.equal(e.title, 'Fall Tree Care Day - Bronx Park'); // &#8211; decoded
    assert.equal(e.time, '10:00 AM–1:30 PM');
    assert.equal(e.location.name, 'Van Cortlandt Park — Midwood');
    assert.equal(e.location.address, 'Van Cortlandt Park, Bronx, NY 10458');
    assert.equal(e.location.city, 'Bronx');
    assert.ok(Math.abs(e.location.lat - 40.8972) < 0.001);
    assert.ok(Math.abs(e.location.lng + 73.886) < 0.001);
    assert.deepEqual(e.price, { isFree: false, min: 5, max: 5, currency: 'USD' });
    assert.deepEqual(e.categories, ['Volunteer', 'Hikes']);
  });

  it('flags an explicitly free cost and tolerates missing fields', () => {
    assert.deepEqual(
      vcp.mapEvent({ ...venueEvent, cost: 'Free' }).price,
      { isFree: true, min: 0, max: 0, currency: 'USD' },
    );
    const bare = vcp.mapEvent({ ...venueEvent, image: undefined, categories: undefined, end_date: undefined });
    assert.deepEqual(bare.images, []);
    assert.deepEqual(bare.categories, []);
    assert.equal(bare.endDate, null);
    assert.equal(bare.time, '10:00 AM');
  });

  it('falls back to start_date_details when the stamp is missing', () => {
    const e = vcp.mapEvent({
      ...timedEvent,
      start_date: undefined,
      end_date: undefined,
    });
    assert.equal(e.startDate, '2026-09-30T09:00:00');
    assert.equal(e.endDate, '2026-09-30T12:00:00');
  });

  it('emits the shared event schema on every event', () => {
    for (const raw of [allDayEvent, timedEvent, venueEvent]) {
      assert.deepEqual(Object.keys(vcp.mapEvent(raw)).sort(), [
        'attendance', 'borough', 'categories', 'description', 'endDate', 'id',
        'images', 'location', 'neighborhood', 'organizer', 'price', 'rawText',
        'source', 'sourceUrl', 'startDate', 'tags', 'ticketUrl', 'time', 'title',
      ]);
    }
  });
});

describe('van-cortlandt-park window', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const at = (iso) => ({ startDate: iso.replace(' ', 'T') });

  it('keeps events starting between now and 30 days ahead', () => {
    const kept = vcp.inWindow([
      at('2026-09-30 06:00:00'),   // today, already started → out (now is 8:00 AM EDT)
      at('2026-09-30 09:00:00'),   // later today → in
      at('2026-10-01 09:00:00'),   // tomorrow
      at('2026-10-29 20:00:00'),   // inside the window
      at('2026-10-30 08:00:00'),   // exactly +30 days
      at('2026-11-05 18:00:00'),   // too far out
      { startDate: null },         // unparseable
    ], now);
    assert.deepEqual(kept.map(e => e.startDate), [
      '2026-09-30T09:00:00',
      '2026-10-01T09:00:00',
      '2026-10-29T20:00:00',
      '2026-10-30T08:00:00',
    ]);
  });

  it('reads the real sample events as in-window on their own dates', () => {
    const events = [vcp.mapEvent(allDayEvent), vcp.mapEvent(timedEvent)];
    assert.equal(vcp.inWindow(events, new Date('2026-09-30T00:00:00Z')).length, 2);
    assert.equal(vcp.inWindow(events, new Date('2026-12-01T00:00:00Z')).length, 0);
  });
});

describe('van-cortlandt-park pageUrl', () => {
  it('asks for one page of the forward window', () => {
    const url = new URL(vcp.pageUrl(2, new Date('2026-09-30T20:00:00Z')));
    assert.equal(url.origin + url.pathname, 'https://www.vancortlandt.org/wp-json/tribe/events/v1/events');
    assert.equal(url.searchParams.get('per_page'), '50');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('start_date'), '2026-09-30');
    assert.equal(url.searchParams.get('end_date'), '2026-10-30');
  });
});