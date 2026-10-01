import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// The crawlers import lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

let whitney, bam, lincoln, carnegie;
before(async () => {
  whitney  = await import('./whitney.js');
  bam      = await import('./bam.js');
  lincoln  = await import('./lincoln-center.js');
  carnegie = await import('./carnegie-hall.js');
});

describe('whitney', () => {
  const record = (attrs) => ({
    id: '61947', type: 'event',
    attributes: {
      id: 61947, title: '15-Minute Tour: <em>The Lost World</em>&nbsp;',
      start_time: '2026-10-09T20:00:00.000-04:00', end_time: '2026-10-09T20:30:00.000-04:00',
      url: '/events/minnie-evans-15-min-tours', open_to: 'All', description: '<p>Meet in the lobby.</p>',
      ...attrs,
    },
  });

  it('maps an occurrence with a per-occurrence id', () => {
    const e = whitney.mapEvent(record());
    assert.equal(e.title, '15-Minute Tour: The Lost World');
    assert.equal(e.sourceUrl, 'https://whitney.org/events/minnie-evans-15-min-tours');
    assert.equal(e.time, '8:00 PM–8:30 PM');
    assert.equal(e.description, 'Meet in the lobby.');
    assert.equal(e.borough, 'Manhattan');
    assert.equal(e.neighborhood, 'Meatpacking District');
    const other = whitney.mapEvent(record({ id: 61948 }));
    assert.notEqual(e.id, other.id);
  });

  it('skips online and members-only events', () => {
    assert.equal(whitney.mapEvent(record({ title: 'Whitney Descriptions Online: Roy Lichtenstein' })), null);
    assert.equal(whitney.mapEvent(record({ title: 'Halloween Member Night: Pop Party' })), null);
  });

  it('filters the API to the forward window', () => {
    const url = new URL(whitney.pageUrl(2, new Date('2026-10-01T12:00:00Z'), 30));
    assert.equal(url.searchParams.get('q[start_time_gteq]'), '2026-10-01T12:00:00.000Z');
    assert.equal(url.searchParams.get('q[start_time_lteq]'), '2026-10-31T12:00:00.000Z');
    assert.equal(url.searchParams.get('page'), '2');
  });
});

describe('bam', () => {
  const row = {
    performances: ['2026-10-13T17:00:00-04:00', '2026-10-13T19:00:00-04:00'],
    performancesShort: ['5pm', '7pm'],
    id: 58562, day: '2026-10-13', genres: 'Opera,Film', name: 'Naza',
    desc: 'Israel&amp;rsquo;s calculated',
    img: '/globalassets/programs/cinema/naza.jpg?width=305&mode=crop',
    buyLink: 'https://commerce.bam.org/production/58562', moreLink: '/film/2026/naza', onGoing: false,
  };

  it('maps a production day', () => {
    const e = bam.mapRow(row);
    assert.equal(e.sourceUrl, 'https://www.bam.org/film/2026/naza');
    assert.equal(e.startDate, '2026-10-13T17:00:00-04:00');
    assert.equal(e.time, '5pm, 7pm');
    assert.equal(e.description, "Israel's calculated");
    assert.deepEqual(e.categories, ['Opera', 'Film']);
    assert.deepEqual(e.images, ['https://www.bam.org/globalassets/programs/cinema/naza.jpg?width=800&quality=80']);
    assert.equal(e.borough, 'Brooklyn');
    assert.equal(e.neighborhood, 'Fort Greene');
    assert.notEqual(e.id, bam.mapRow({ ...row, day: '2026-10-14' }).id);
  });

  it('asks the API for NYC dates', () => {
    assert.equal(
      bam.calendarUrl(new Date('2026-10-02T02:00:00Z'), 14),
      'https://www.bam.org/api/BAMApi/GetCalendarEventsByDayWithOnGoing?start=10/01/2026&end=10/15/2026',
    );
  });
});

describe('lincoln-center', () => {
  const show = {
    title: 'Puccini&#39;s <em>Tosca</em>', slug: 'https://www.metopera.org/season/2026-27-season/tosca/',
    dateRange: { start: '2026-11-01T20:00:00.000Z' }, time: ['3:00 pm'], typeClasses: ['other'],
    organization: 'the-metropolitan-opera', eventTypeClass: 'filter-border-in-person', h2: '',
  };

  it('maps a show with its organization', () => {
    const e = lincoln.mapShow(show);
    assert.equal(e.title, "Puccini's Tosca");
    assert.equal(e.organizer, 'The Metropolitan Opera');
    assert.deepEqual(e.categories, ['Opera']);
    assert.equal(e.time, null);
    assert.equal(e.location.name, 'Lincoln Center');
    assert.equal(e.borough, 'Manhattan');
  });

  it('puts Jazz at Lincoln Center at Columbus Circle and lists every show time', () => {
    const e = lincoln.mapShow({ ...show, organization: 'jazz-at-lincoln-center', typeClasses: ['jazz'], time: ['7:30 pm', '9:30 pm'] });
    assert.match(e.location.address, /Columbus Circle/);
    assert.equal(e.time, '7:30 pm, 9:30 pm');
  });

  it('skips digital shows', () => {
    assert.equal(lincoln.mapShow({ ...show, eventTypeClass: 'filter-border-digital' }), null);
  });

  it('asks for this month and next in NYC time', () => {
    assert.deepEqual(lincoln.monthUrls(new Date('2026-12-31T23:00:00-05:00')), [
      'https://www.lincolncenter.org/ajaxCalendar/December%202026',
      'https://www.lincolncenter.org/ajaxCalendar/January%202027',
    ]);
  });
});

describe('carnegie-hall', () => {
  it('reads date, time and title from a performance URL', () => {
    const e = carnegie.mapPerformance('https://www.carnegiehall.org/Calendar/2026/10/02/Ludovico-Einaudi-0800PM');
    assert.equal(e.title, 'Ludovico Einaudi');
    assert.equal(e.startDate, '2026-10-02T20:00');
    assert.equal(e.time, '8:00 PM');
    assert.equal(e.neighborhood, 'Midtown');
    assert.equal(carnegie.parsePerformanceUrl('https://www.carnegiehall.org/Calendar/2026/11/07/Miclot-0100PM').startDate, '2026-11-07T13:00');
    assert.equal(carnegie.parsePerformanceUrl('https://www.carnegiehall.org/Calendar/2026/11/07/Matinee-1200PM').startDate, '2026-11-07T12:00');
    assert.equal(carnegie.parsePerformanceUrl('https://www.carnegiehall.org/About/History'), null);
  });

  it('keeps performances in the next 30 days', () => {
    const xml = `<urlset>
      <url><loc>https://www.carnegiehall.org/Calendar/2026/09/30/Past-0800PM</loc></url>
      <url><loc>https://www.carnegiehall.org/Calendar/2026/10/01/Today-0800PM</loc></url>
      <url><loc>https://www.carnegiehall.org/Calendar/2026/10/31/Edge-0800PM</loc></url>
      <url><loc>https://www.carnegiehall.org/Calendar/2026/11/02/Later-0800PM</loc></url>
      <url><loc>https://www.carnegiehall.org/About/History</loc></url>
    </urlset>`;
    assert.deepEqual(
      carnegie.upcomingUrls(xml, new Date('2026-10-01T12:00:00Z')).map(u => u.split('/').pop()),
      ['Today-0800PM', 'Edge-0800PM'],
    );
  });
});
