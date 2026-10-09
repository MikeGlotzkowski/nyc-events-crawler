import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSameEvent,
  groupCanonical,
  mergeCanonicalFields,
  eventRichness,
  titleSimilarity,
  CANONICAL_MATCH_THRESHOLD,
  CANONICAL_COORD_MILES,
  CANONICAL_TIME_WINDOW_MINUTES,
} from './canonical.js';

// ~0.03 mi from Brooklyn Steel; ~0.72 mi away (well outside the 0.3 mi window).
const NEAR = { lat: 40.7200, lng: -73.9415 };
const FAR  = { lat: 40.7300, lng: -73.9410 };

/** Build a crawler-shaped event. */
const ev = (o) => ({
  id:          o.id,
  source:      o.source,
  title:       o.title,
  description: o.description ?? '',
  images:      o.images ?? [],
  price:       o.price ?? { min: null, max: null, isFree: false },
  startDate:   o.startDate,
  time:        o.time ?? null,
  location:    { name: o.venue ?? 'Brooklyn Steel', lat: o.lat ?? null, lng: o.lng ?? null },
  ticketUrl:   o.ticketUrl ?? null,
  sourceUrl:   o.sourceUrl ?? null,
  categories:  o.categories ?? [],
  tags:        o.tags ?? [],
});

const DICE = ev({
  id: 'dice-1', source: 'DICE', title: 'Bonobo',
  startDate: '2026-10-17T21:00:00-04:00', venue: 'Brooklyn Steel',
  lat: NEAR.lat, lng: NEAR.lng,
  ticketUrl: 'https://dice.fm/event/bonobo-bk',
});
const RA = ev({
  id: 'ra-1', source: 'Resident Advisor', title: 'Bonobo',
  description: 'Bonobo returns to Brooklyn Steel with a full live band, spanning his catalogue. '.repeat(6),
  images: ['https://ra.co/flyer.jpg'],
  price: { min: 25, max: null, isFree: false },
  startDate: '2026-10-17T21:00:00-04:00', venue: 'Brooklyn Steel',
  lat: NEAR.lat, lng: NEAR.lng,
  ticketUrl: 'https://ra.co/events/1234',
  categories: ['Nightlife', 'Music'], tags: ['Techno'],
});
const TIMEOUT = ev({
  id: 'to-1', source: 'Time Out New York', title: 'Bonobo at Brooklyn Steel',
  description: 'A night of downtempo and bass.',
  price: { min: 30, max: 40, isFree: false },
  startDate: '2026-10-17T21:00:00-04:00', venue: 'Brooklyn Steel',
  lat: NEAR.lat, lng: NEAR.lng,
  ticketUrl: 'https://www.timeout.com/newyork/bonobo',
});

describe('canonical constants', () => {
  it('exposes named thresholds', () => {
    assert.equal(typeof CANONICAL_MATCH_THRESHOLD, 'number');
    assert.ok(CANONICAL_MATCH_THRESHOLD > 0 && CANONICAL_MATCH_THRESHOLD <= 1);
    assert.ok(CANONICAL_COORD_MILES > 0);
    assert.ok(CANONICAL_TIME_WINDOW_MINUTES > 0);
  });
});

describe('same show from DICE + RA + Time Out', () => {
  it('merges the three sources into one canonical group', () => {
    const groups = groupCanonical([DICE, RA, TIMEOUT]);
    assert.equal(groups.length, 1);
  });

  it('lists every source in dup_sources', () => {
    const [g] = groupCanonical([DICE, RA, TIMEOUT]);
    const sources = new Set(g.dup_sources.map((d) => d.source));
    assert.deepEqual(sources, new Set(['DICE', 'Resident Advisor', 'Time Out New York']));
    assert.equal(g.dup_sources.length, 3);
  });

  it('keeps the richest row visible and marks the other two duplicates', () => {
    const [g] = groupCanonical([DICE, RA, TIMEOUT]);
    assert.equal(g.canonical.id, 'ra-1');
    assert.deepEqual(new Set(g.duplicates.map((d) => d.id)), new Set(['dice-1', 'to-1']));
  });

  it('is order-independent (transitive clustering)', () => {
    const [g] = groupCanonical([TIMEOUT, DICE, RA]);
    assert.equal(g.canonical.id, 'ra-1');
    assert.equal(g.dup_sources.length, 3);
  });
});

describe('richest row wins', () => {
  it('scores the rich RA row above the two sparse rows', () => {
    assert.ok(eventRichness(RA) > eventRichness(DICE));
    assert.ok(eventRichness(RA) > eventRichness(TIMEOUT));
  });

  it('mergeCanonicalFields makes the winner canonical and lists all members', () => {
    const merged = mergeCanonicalFields(RA, [DICE, TIMEOUT]);
    assert.equal(merged.canonical_event_id, 'ra-1');
    assert.equal(merged.dup_sources.length, 3);
    assert.ok(merged.images.includes('https://ra.co/flyer.jpg'));
  });
});

describe('guards against over-merging', () => {
  it('never merges two rows whose dates differ', () => {
    const next = { ...RA, id: 'ra-2', startDate: '2026-10-18T21:00:00-04:00' };
    assert.equal(isSameEvent(DICE, next), false);
    assert.equal(groupCanonical([DICE, next]).length, 0);
  });

  it('keeps distinct recurring sessions separate (weekly + matinee/evening)', () => {
    // Same show, same venue, different weeks.
    const nextWeek = { ...TIMEOUT, id: 'to-2', startDate: '2026-10-24T21:00:00-04:00' };
    assert.equal(groupCanonical([DICE, nextWeek]).length, 0);

    // Same day, same venue, but six hours apart (matinee vs evening) — not the same session.
    const matinee = { ...TIMEOUT, id: 'to-3', startDate: '2026-10-17T14:00:00-04:00', time: '2:00 PM' };
    const evening = { ...DICE, time: '8:00 PM' };
    assert.equal(isSameEvent(evening, matinee), false);
    assert.equal(groupCanonical([evening, matinee]).length, 0);
  });

  it('does not merge rows whose coordinates are >0.3 mi apart', () => {
    const far = { ...RA, id: 'ra-far', location: { name: 'Brooklyn Steel', lat: FAR.lat, lng: FAR.lng } };
    assert.equal(isSameEvent(DICE, far), false);
    assert.equal(groupCanonical([DICE, far]).length, 0);
  });

  it('does not merge on a title match that is below threshold with no corroborating signals', () => {
    const a = ev({ id: 'a', source: 'DICE', title: 'Warehouse Rave', startDate: '2026-10-17T21:00:00-04:00', venue: 'Brooklyn Steel', ticketUrl: 'https://dice.fm/e/a' });
    const b = ev({ id: 'b', source: 'Resident Advisor', title: 'Sunday Yoga Class', startDate: '2026-10-17T21:00:00-04:00', venue: 'Brooklyn Steel', ticketUrl: 'https://ra.co/e/b' });
    assert.equal(isSameEvent(a, b), false);
    assert.equal(groupCanonical([a, b]).length, 0);

    // A partial title overlap alone stays under threshold: no title weight, no ticket
    // host and no coords to corroborate the merge.
    const c = ev({ id: 'c', source: 'DICE', title: 'Underground Techno Night', startDate: '2026-10-17T21:00:00-04:00', venue: 'Brooklyn Steel' });
    const d = ev({ id: 'd', source: 'Time Out New York', title: 'Underground House Sessions', startDate: '2026-10-17T21:00:00-04:00', venue: 'Brooklyn Steel' });
    assert.ok(titleSimilarity(c.title, d.title) < CANONICAL_MATCH_THRESHOLD);
    assert.equal(isSameEvent(c, d), false);
  });

  it('never self-merges rows from the same source', () => {
    const other = { ...DICE, id: 'dice-2' };
    assert.equal(isSameEvent(DICE, other), false);
    assert.equal(groupCanonical([DICE, other]).length, 0);
  });

  it('does not compare rows without a source or a date', () => {
    assert.equal(isSameEvent({ ...DICE, source: null }, RA), false);
    assert.equal(isSameEvent({ ...DICE, startDate: null }, RA), false);
  });
});
