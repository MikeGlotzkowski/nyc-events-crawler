import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import nodeIcal from 'node-ical';

// The crawler imports lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

let ical;
before(async () => {
  ical = await import('./ical-feeds.js');
});

// Trimmed from the live feeds (probed 2026-10-09).
const NYU_SOURCE = {
  name: 'NYU',
  feed: 'https://events.nyu.edu/live/ical/events',
  neighborhood: 'Greenwich Village',
  borough: 'Manhattan',
};
const BRYANT_SOURCE = {
  name: 'Bryant Park',
  feed: 'https://bryantpark.org/calendar/export',
  neighborhood: 'Midtown',
  borough: 'Manhattan',
  nycFloating: true,
};

// LiveWhale (events.nyu.edu): explicit TZID, real instants.
const NYU_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//NYU Events Calendar//NONSGML v1.0//EN',
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:STANDARD',
  'TZNAME:EST',
  'DTSTART:20261101T060000',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:20261015T190000-1@events.nyu.edu',
  'DTSTART;TZID=America/New_York:20261015T190000',
  'DTEND;TZID=America/New_York:20261015T210000',
  'SUMMARY:NYU Lecture',
  'LOCATION:Kimmel Center 275',
  'URL:https://engage.nyu.edu/event/1',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

// Solspace Calendar (bryantpark.org): floating local times, no TZID, no VTIMEZONE.
const BRYANT_ICS = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Solspace/Calendar 2.x//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'BEGIN:VEVENT',
  'UID:fb6e9681a1e042f76a78aca0fa866a74@solspace.com',
  'DTSTAMP:20261009T181830',
  'DTSTART:20261015T190000',
  'DTEND:20261015T200000',
  'SUMMARY:Yoga Wednesdays',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const vevent = (parsed) => Object.values(parsed).find(c => c.type === 'VEVENT');

describe('ical-feeds NYU (LiveWhale, TZID=America/New_York)', () => {
  it('maps a timed VEVENT to its real NYC instant', () => {
    const e = ical.mapVEvent(vevent(nodeIcal.parseICS(NYU_ICS)), NYU_SOURCE);
    assert.equal(e.source, 'NYU');
    assert.equal(e.organizer, 'NYU');
    assert.equal(e.title, 'NYU Lecture');
    assert.equal(e.startDate, '2026-10-15T23:00:00.000Z'); // 7:00 PM EDT
    assert.equal(e.location.name, 'Kimmel Center 275');
    assert.equal(e.sourceUrl, 'https://engage.nyu.edu/event/1');
    assert.equal(e.ticketUrl, 'https://engage.nyu.edu/event/1');
    assert.equal(e.borough, 'Manhattan');
    assert.deepEqual(e.tags, ['ical']);
  });
});

describe('ical-feeds Bryant Park (Solspace, floating local times)', () => {
  it('anchors a floating feed to NYC and reads the DTSTART as NYC wall clock', () => {
    const anchored = nodeIcal.parseICS(ical.anchorFloatingFeedToNyc(BRYANT_ICS));
    const e = ical.mapVEvent(vevent(anchored), BRYANT_SOURCE);
    assert.equal(e.source, 'Bryant Park');
    assert.equal(e.title, 'Yoga Wednesdays');
    // 19:00 floating means 7:00 PM in Bryant Park — 23:00Z in EDT, never 19:00Z.
    assert.equal(e.startDate, '2026-10-15T23:00:00.000Z');
    assert.equal(e.sourceUrl, 'https://bryantpark.org/calendar/export'); // feed has no per-event URL
    assert.equal(e.borough, 'Manhattan');
  });

  it('leaves a feed that already declares a VTIMEZONE untouched', () => {
    assert.equal(ical.anchorFloatingFeedToNyc(NYU_ICS), NYU_ICS);
  });

  it('expands RRULEs DST-correctly across the November transition (never DST-blind)', () => {
    const weekly = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:x@solspace.com',
      'DTSTART:20260406T110000',
      'DTEND:20260406T120000',
      'RRULE:FREQ=WEEKLY;UNTIL=20270104T235959Z;INTERVAL=1',
      'SUMMARY:Park Tour',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const ev = vevent(nodeIcal.parseICS(ical.anchorFloatingFeedToNyc(weekly)));
    const occurrences = nodeIcal.expandRecurringEvent(ev, {
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-05T00:00:00Z'),
    });
    // 11:00 NYC on 2026-11-02 is EST (UTC-5) → 16:00Z. DST-blind expansion would give 15:00Z.
    assert.equal(occurrences[0].start.toISOString(), '2026-11-02T16:00:00.000Z');
  });
});
