import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEventDates, parseStartTime, nycWallToDate } from './nyc-time.js';

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
