import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEventDates, parseStartTime, nycWallToDate, nycClock, nycTimeRange, nycYmd, formatClock } from './nyc-time.js';

describe('normalizeEventDates', () => {
  it('keeps a late-evening instant on its NYC day (9pm Sunday EDT)', () => {
    // 2026-09-27 21:00 EDT == 2026-09-28T01:00Z — used to be stored as the 28th
    const r = normalizeEventDates('2026-09-28T01:00:00.000Z', null);
    assert.equal(r.startDate, '2026-09-27');
    assert.equal(r.startAt, '2026-09-28T01:00:00.000Z');
    assert.equal(r.time, '9:00 PM');
  });

  it('accepts Date objects as instants', () => {
    const r = normalizeEventDates(new Date('2026-12-06T02:30:00Z'), null);
    assert.equal(r.startDate, '2026-12-05'); // EST, 9:30pm
    assert.equal(r.time, '9:30 PM');
  });

  it('reads offset-less timestamps as NYC wall-clock (Socrata floating, riverside)', () => {
    const r = normalizeEventDates('2026-09-27T21:00:00.000', null);
    assert.equal(r.startDate, '2026-09-27');
    assert.equal(r.startAt, '2026-09-28T01:00:00.000Z');
    const w = normalizeEventDates('2026-01-15 19:30:00', '7:30 PM');
    assert.equal(w.startAt, '2026-01-16T00:30:00.000Z'); // EST
    assert.equal(w.time, '7:30 PM'); // source time kept
  });

  it('date-only uses the 0044 midnight-UTC convention', () => {
    const r = normalizeEventDates('2026-09-28', null);
    assert.deepEqual(r, { startDate: '2026-09-28', startAt: '2026-09-28T00:00:00.000Z', endDate: null, time: null });
  });

  it('date-only + free-text time → NYC instant', () => {
    assert.equal(normalizeEventDates('2026-09-27', '9:00 PM – 11:00 PM').startAt, '2026-09-28T01:00:00.000Z');
    assert.equal(normalizeEventDates('2026-07-04', '7-9pm').startAt, '2026-07-04T23:00:00.000Z');
  });

  it('treats NYC midnight timestamps as date-only', () => {
    const r = normalizeEventDates('2026-09-28T00:00:00.000', null);
    assert.equal(r.startDate, '2026-09-28');
    assert.equal(r.startAt, '2026-09-28T00:00:00.000Z');
    assert.equal(r.time, null);
  });

  it('parses free-text dates as calendar dates and nulls unparseable ones', () => {
    assert.equal(normalizeEventDates('September 28, 2026', null).startDate, '2026-09-28');
    assert.equal(normalizeEventDates('Sep 28 Sunday', null).startDate, null);
    assert.equal(normalizeEventDates(null, null).startAt, null);
  });

  it('normalizes endDate to the NYC calendar date', () => {
    assert.equal(normalizeEventDates('2026-09-27', null, '2026-09-28T03:00:00Z').endDate, '2026-09-27');
  });
});

describe('parseStartTime', () => {
  it('handles common formats', () => {
    assert.deepEqual(parseStartTime('7:00 PM'), { h: 19, mi: 0 });
    assert.deepEqual(parseStartTime('12 p.m.'), { h: 12, mi: 0 });
    assert.deepEqual(parseStartTime('12:30am'), { h: 0, mi: 30 });
    assert.deepEqual(parseStartTime('19:30'), { h: 19, mi: 30 });
    assert.equal(parseStartTime('All day'), null);
    assert.equal(parseStartTime(null), null);
  });
});

describe('nycWallToDate', () => {
  it('handles DST boundaries', () => {
    assert.equal(nycWallToDate(2026, 3, 8, 3, 30).toISOString(), '2026-03-08T07:30:00.000Z'); // after spring-forward
    assert.equal(nycWallToDate(2026, 11, 1, 12, 0).toISOString(), '2026-11-01T17:00:00.000Z'); // after fall-back
  });
});

// ── B3: one clock path for every crawler ────────────────────────

// Independent reference (the Intl the crawlers used to duplicate) so the shared
// helper is checked against a second implementation, not against itself.
const refClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
});
const refYmd = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const refLabel = (d) => refClock.format(d).replace(/[\u202f\u00a0]/g, ' ').trim();

describe('nycClock / nycTimeRange / nycYmd', () => {
  it('formats a real instant to NYC wall clock, and a range only when the end is later', () => {
    assert.equal(nycClock('2026-10-15T23:00:00.000Z'), '7:00 PM'); // EDT
    assert.equal(nycClock(new Date('2026-01-15T00:30:00Z')), '7:30 PM'); // EST
    assert.equal(nycClock('not-a-date'), null);
    assert.equal(nycClock(null), null);
    assert.equal(nycTimeRange('2026-10-01T17:30:00Z', '2026-10-01T19:30:00Z'), '1:30 PM–3:30 PM');
    assert.equal(nycTimeRange('2026-10-01T17:30:00Z', null), '1:30 PM');
    assert.equal(nycTimeRange('2026-10-01T17:30:00Z', '2026-10-01T17:30:00Z'), '1:30 PM');
    assert.equal(nycTimeRange(null, null), null);
    assert.equal(nycYmd('2026-09-28T01:00:00Z'), '2026-09-27'); // still the 27th in NYC
  });

  it('uses narrow no-break spaces nowhere (stable, plain ASCII labels)', () => {
    assert.doesNotMatch(nycClock('2026-10-01T17:30:00Z'), /[\u202f\u00a0]/);
    assert.doesNotMatch(nycTimeRange('2026-10-01T17:30:00Z', '2026-10-01T19:30:00Z'), /[\u202f\u00a0]/);
  });

  // Property: check the shared formatter against an independent Intl implementation
  // over random instants spanning two years — including both 2026 DST boundaries
  // (2026-03-08 spring-forward, 2026-11-01 fall-back) — and both halves of them.
  it('agrees with an independent formatter over random instants across DST boundaries', () => {
    let seed = 0x9e3779b9;
    const rand = () => {
      // xorshift32, deterministic
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const start = Date.UTC(2026, 0, 1);
    const span = 730 * 86400000; // through 2027-12-31
    for (let i = 0; i < 4000; i++) {
      const t = start + Math.floor(rand() * span);
      const d = new Date(t);
      assert.equal(nycClock(d), refLabel(d), `clock mismatch at ${d.toISOString()}`);
      assert.equal(nycYmd(d), refYmd.format(d), `ymd mismatch at ${d.toISOString()}`);
    }
  });

  it('stays correct on either side of both DST transitions (not DST-blind)', () => {
    // 2026-03-08 01:59 EST (UTC-5) → 06:59Z ; 03:00 EDT (UTC-4) → 07:00Z
    assert.equal(nycClock('2026-03-08T06:59:00Z'), '1:59 AM');
    assert.equal(nycClock('2026-03-08T07:00:00Z'), '3:00 AM');
    // 2026-11-01 01:30 EDT (UTC-4) = 05:30Z ; 01:30 EST (UTC-5) = 06:30Z
    assert.equal(nycClock('2026-11-01T05:30:00Z'), '1:30 AM');
    assert.equal(nycClock('2026-11-01T06:30:00Z'), '1:30 AM');
    assert.equal(nycYmd('2026-03-08T04:30:00Z'), '2026-03-07'); // 11:30pm EST the night before
  });
});

// These are exactly the helpers the crawlers now share, so their behaviour is
// pinned here once instead of once per crawler.
describe('shared formatters used by the crawlers', () => {
  it('formatClock mirrors nycClock for a wall time', () => {
    assert.equal(formatClock(19, 0), nycClock('2026-10-15T23:00:00.000Z'));
    assert.equal(formatClock(0, 30), '12:30 AM');
    assert.equal(formatClock(12, 0), '12:00 PM');
  });
});
