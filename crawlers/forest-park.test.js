import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// The crawler imports lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

let fp;
before(async () => {
  fp = await import('./forest-park.js');
});

// Trimmed from a real forestparktrust.org /events?format=json `upcoming[]` item.
const restoration = {
  id: '6ab2a4192db5926027644740',
  collectionId: '5f74d7b1c9100c20ef2228c9',
  recordTypeLabel: 'event',
  title: '10/2 Restoration Fridays at Forest Park',
  body: '<div class="sqs-layout sqs-grid-12 columns-12"><div class="row sqs-row"><div class="col"><div class="sqs-block html-block">Join us for Forest Park restoration &amp; stewardship. Bring gloves &#8212; we&#8217;ll provide the rest.</div></div></div></div></div>',
  excerpt: '',
  location: {
    mapZoom: 12.0,
    mapLat: 40.6994393,
    mapLng: -73.8552304,
    markerLat: 40.7207559,
    markerLng: -74.0007613,
    addressTitle: '',
    addressLine1: '',
    addressLine2: 'Queens, NY, 11421',
    addressCountry: 'United States',
  },
  fullUrl: '/events/9qq6rqvdgflq8mje0j3zsrtavbvfz5-ef6ht-barmr-tjlrn-ny8bw-jt5c5-5kj6p-ac54c-acm22-h254e-yjhj2-7pcyl',
  assetUrl: 'https://images.squarespace-cdn.com/content/v1/5f2b0fb8e4b73c703250481c/1750793005845-K4F45W88Y9OOHD7U9C27/20250523_124652.jpg',
  contentType: 'image/jpeg',
  structuredContent: { _type: 'CalendarEvent', startDate: 1790949600289, endDate: 1790956800289 },
  startDate: 1790949600289,
  endDate: 1790956800289,
  items: [],
  tags: [],
  categories: [],
};

const cityOfForestDay = {
  id: '6a99ccfcf7c0963ebda379db',
  title: 'City of Forest Day: Forest Restoration Walk',
  excerpt: 'A guided walk of the city&#8217;s largest park.',
  body: '<div class="sqs-layout">Walk the trails of Forest Park.</div>',
  location: {
    mapZoom: 12.0,
    mapLat: 40.7207559,
    mapLng: -74.0007613,
    markerLat: 40.7207559,
    markerLng: -74.0007613,
    addressTitle: '',
    addressLine1: '',
    addressLine2: '',
    addressCountry: '',
  },
  fullUrl: '/events/city-of-forest-day-2026',
  assetUrl: 'https://images.squarespace-cdn.com/content/v1/5f2b0fb8e4b73c703250481c/1790088995224-DIHFSLZBK3ZVOMTZ901Z/20240823_130720.jpg',
  startDate: 1791039600366,
  endDate: 1791045000366,
  tags: ['restoration'],
  categories: ['Volunteer'],
};

describe('forest-park mapItem', () => {
  it('maps a Squarespace upcoming item to the shared event shape', () => {
    const e = fp.mapItem(restoration);
    assert.equal(e.source, 'Forest Park Trust');
    assert.equal(e.organizer, 'Forest Park Trust');
    assert.equal(e.title, '10/2 Restoration Fridays at Forest Park');
    assert.equal(e.sourceUrl, 'https://www.forestparktrust.org' + restoration.fullUrl);
    assert.equal(e.ticketUrl, e.sourceUrl);
    assert.equal(e.startDate, '2026-10-02T14:00:00.289Z');
    assert.equal(e.endDate, '2026-10-02T16:00:00.289Z');
    assert.equal(e.time, '10:00 AM–12:00 PM'); // America/New_York, EDT
    assert.equal(e.location.name, 'Forest Park'); // empty addressTitle falls back
    assert.equal(e.location.address, 'Queens, NY, 11421');
    assert.equal(e.location.city, 'New York');
    assert.ok(Math.abs(e.location.lat - 40.7207559) < 0.0001);
    assert.ok(Math.abs(e.location.lng + 74.0007613) < 0.0001);
    assert.deepEqual(e.images, [restoration.assetUrl]);
    assert.deepEqual(e.categories, []);
    assert.deepEqual(e.tags, []);
    assert.deepEqual(e.price, { isFree: null, min: null, max: null, currency: 'USD' });
    assert.equal(e.attendance, null);
    assert.equal(e.rawText, null);
    assert.equal(e.neighborhood, 'Forest Park');
    assert.equal(e.borough, 'Queens');
    assert.equal(e.id.length, 16);
  });

  it('prefers the excerpt, decodes entities and falls back to the body', () => {
    const fromExcerpt = fp.mapItem(cityOfForestDay);
    assert.equal(fromExcerpt.description, "A guided walk of the city's largest park.");
    assert.equal(fromExcerpt.startDate, '2026-10-03T15:00:00.366Z');
    assert.equal(fromExcerpt.time, '11:00 AM–12:30 PM');
    assert.deepEqual(fromExcerpt.categories, ['Volunteer']);
    assert.deepEqual(fromExcerpt.tags, ['restoration']);
    assert.equal(fromExcerpt.location.address, null); // no address lines at all
    assert.equal(fromExcerpt.time, '11:00 AM–12:30 PM');

    // Empty excerpt (as the live feed returns) → stripped body text, entities decoded
    assert.equal(
      fp.mapItem(restoration).description,
      'Join us for Forest Park restoration & stewardship. Bring gloves - we\'ll provide the rest.',
    );
  });

  it('caps the description at 2000 characters', () => {
    const long = fp.mapItem({ ...restoration, excerpt: `${'a '.repeat(2000)}TAIL` });
    assert.equal(long.description.length, 2000);
    assert.ok(!long.description.endsWith('TAIL'));
  });

  it('accepts epoch milliseconds sent as strings and tolerates a missing end', () => {
    const s = fp.mapItem({ ...restoration, startDate: '1790949600289', endDate: undefined });
    assert.equal(s.startDate, '2026-10-02T14:00:00.289Z');
    assert.equal(s.endDate, null);
    assert.equal(s.time, '10:00 AM');
  });

  it('nulls out zero marker coords and a missing image', () => {
    const e = fp.mapItem({
      ...restoration,
      assetUrl: undefined,
      location: { ...restoration.location, markerLat: 0, markerLng: 0 },
    });
    assert.deepEqual(e.images, []);
    assert.equal(e.location.lat, null);
    assert.equal(e.location.lng, null);
  });

  it('drops items without a title, fullUrl or start date', () => {
    assert.equal(fp.mapItem({ ...restoration, title: '  ' }), null);
    assert.equal(fp.mapItem({ ...restoration, fullUrl: undefined }), null);
    assert.equal(fp.mapItem({ ...restoration, startDate: undefined }), null);
    assert.equal(fp.mapItem({ ...restoration, startDate: 'not-a-date' }), null);
    assert.equal(fp.mapItem({}), null);
  });
});

describe('forest-park window and time helpers', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');

  it('keeps events from now up to 30 days ahead', () => {
    assert.equal(fp.withinWindow('2026-10-02T14:00:00.289Z', now), true);
    assert.equal(fp.withinWindow('2026-10-30T12:00:00Z', now), true); // exactly 30d
    assert.equal(fp.withinWindow('2026-10-02T14:00:00.289Z', Date.parse('2026-10-05T12:00:00Z')), false);
    assert.equal(fp.withinWindow('2026-10-31T12:00:00Z', now), false);
    assert.equal(fp.withinWindow('2026-09-01T12:00:00Z', now), false);
    assert.equal(fp.withinWindow(null, now), false);
  });

  it('formats NYC wall-clock labels from instants', () => {
    assert.equal(fp.nycTimeLabel('2026-10-03T15:00:00.366Z'), '11:00 AM');
    assert.equal(fp.nycTimeLabel('2026-10-03T16:30:00.366Z'), '12:30 PM');
    assert.equal(fp.nycTimeLabel(null), null);
    assert.equal(fp.timeRangeLabel('2026-10-03T15:00:00.366Z', null), '11:00 AM');
    assert.equal(fp.timeRangeLabel(null, null), null);
  });

  it('converts epoch ms (number or string) to ISO instants', () => {
    assert.equal(fp.toIsoInstant(1791039600366), '2026-10-03T15:00:00.366Z');
    assert.equal(fp.toIsoInstant('1791039600366'), '2026-10-03T15:00:00.366Z');
    assert.equal(fp.toIsoInstant(undefined), null);
    assert.equal(fp.toIsoInstant(''), null);
    assert.equal(fp.toIsoInstant('nope'), null);
  });
});
