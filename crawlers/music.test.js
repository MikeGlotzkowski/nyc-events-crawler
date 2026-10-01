import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// The crawlers import lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

let ra, dice;
before(async () => {
  ra   = await import('./resident-advisor.js');
  dice = await import('./dice.js');
});

describe('resident-advisor', () => {
  it('reads free-text costs', () => {
    assert.deepEqual(ra.parsePrice('$20+'), { isFree: false, min: 20, max: null, currency: 'USD' });
    assert.deepEqual(ra.parsePrice('29.50-55.50'), { isFree: false, min: 29.5, max: 55.5, currency: 'USD' });
    assert.deepEqual(ra.parsePrice('$0.00'), { isFree: true, min: 0, max: null, currency: 'USD' });
    assert.deepEqual(ra.parsePrice(''), { isFree: null, min: null, max: null, currency: 'USD' });
  });

  const event = (venue) => ({
    id: '1', title: 'Night', startTime: '2026-10-01T22:00:00.000', contentUrl: '/events/1',
    content: 'Dance all night.\n\n///\n\nDoor policy.', images: [], genres: [{ name: 'House' }], venue,
  });

  it('keeps NYC venues and drops the door policy from the description', () => {
    const e = ra.mapEvent(event({ name: 'Good Room', address: '98 Meserole Ave, Brooklyn, NY 11222 USA', location: { latitude: 0, longitude: 0 } }));
    assert.equal(e.borough, 'Brooklyn');
    assert.equal(e.description, 'Dance all night.');
    assert.equal(e.location.lat, null);
    assert.equal(e.sourceUrl, 'https://ra.co/events/1');
  });

  it('drops New Jersey and TBA venues', () => {
    assert.equal(ra.mapEvent(event({ name: 'White Eagle Hall', address: '337 Newark Ave, Jersey City, NJ 07302' })), null);
    assert.equal(ra.mapEvent(event({ name: 'TBA - Brooklyn', address: null })), null);
  });
});

describe('dice', () => {
  it('reads prices in cents', () => {
    assert.deepEqual(dice.mapPrice({ currency: 'USD', amount: 3994, amount_from: null }), { isFree: false, min: 39.94, max: null, currency: 'USD' });
    assert.deepEqual(dice.mapPrice({ currency: 'USD', amount: null, amount_from: 0 }), { isFree: true, min: 0, max: null, currency: 'USD' });
    assert.deepEqual(dice.mapPrice({ currency: 'USD', amount: null, amount_from: null }), { isFree: null, min: null, max: null, currency: 'USD' });
  });

  it('reads events from __NEXT_DATA__', () => {
    const html = '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"events":[{"id":"a"}]}}}</script>';
    assert.deepEqual(dice.pageEvents(html), [{ id: 'a' }]);
  });

  it('maps an NYC event', () => {
    const e = dice.mapEvent({
      id: 'abc', name: ' The Jungle Giants ', status: 'sold-out', images: { square: 'https://img/x.jpg' },
      dates: { event_start_date: '2026-10-01T19:00:00-04:00', event_end_date: null },
      venues: [{ name: 'Elsewhere', address: '599 Johnson Ave #1, Brooklyn, NY 11237, USA' }],
      price: { currency: 'USD', amount: 3994 },
    }, ['Concert']);
    assert.equal(e.title, 'The Jungle Giants');
    assert.equal(e.sourceUrl, 'https://dice.fm/event/abc');
    assert.equal(e.borough, 'Brooklyn');
    assert.deepEqual(e.tags, ['Sold out']);
    assert.deepEqual(e.categories, ['Concert']);
  });
});
