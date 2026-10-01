import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// The crawlers import lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

let parks, opendata;
before(async () => {
  parks = await import('./nyc-parks.js');
  opendata = await import('./nyc-opendata.js');
});

const parksRow = {
  title: 'Line Dance Fitness',
  guid: '2260759',
  link: { url: 'http://www.nycgovparks.org/events/2026/09/30/line-dance-fitness' },
  description: 'Line up and get ready to move.',
  registration_url: { url: 'https://nycparks.perfectmind.com/book' },
  parkids: 'B008',
  parknames: 'Betsy Head Park',
  starttime: '2026-09-30T20:00:00.000',
  endtime: '2026-09-30T21:30:00.000',
  location: 'Handball Court (in Betsy Head Park)',
  categories: 'Dance | Fitness | Shape Up NYC',
  coordinates: '40.66203011782100000, -73.91401224247200000',
  image: { url: 'https://www.nycgovparks.org/photo.jpg' },
};

describe('nyc-parks mapSocrataRow', () => {
  it('maps a w3wp-dpdi row to the shared event shape', () => {
    const e = parks.mapSocrataRow(parksRow);
    assert.equal(e.source, 'NYC Parks');
    assert.equal(e.title, 'Line Dance Fitness');
    assert.equal(e.sourceUrl, parksRow.link.url);
    assert.equal(e.startDate, '2026-09-30T20:00:00.000'); // raw NYC wall clock, normalized on upsert
    assert.equal(e.endDate, '2026-09-30T21:30:00.000');
    assert.equal(e.time, '8:00 PM–9:30 PM');
    assert.deepEqual(e.categories, ['Dance', 'Fitness', 'Shape Up NYC']);
    assert.deepEqual(e.images, ['https://www.nycgovparks.org/photo.jpg']);
    assert.equal(e.ticketUrl, 'https://nycparks.perfectmind.com/book');
    assert.equal(e.borough, 'Brooklyn');
    assert.equal(e.location.name, 'Betsy Head Park');
    assert.ok(Math.abs(e.location.lat - 40.662) < 0.001);
    assert.ok(Math.abs(e.location.lng + 73.914) < 0.001);
  });

  it('keeps the same id as the RSS path for the same event', () => {
    const rssItem = {
      title: [parksRow.title],
      link: [parksRow.link.url],
      description: [parksRow.description],
      'event:startdate': ['2026-09-30'],
      'event:parknames': [parksRow.parknames],
      'event:parkids': [parksRow.parkids],
      'event:categories': [parksRow.categories],
    };
    const fromRss = parks.parseItem(rssItem);
    assert.equal(parks.mapSocrataRow(parksRow).id, fromRss.id);
    assert.deepEqual(fromRss.categories, ['Dance', 'Fitness', 'Shape Up NYC']);
    assert.equal(fromRss.borough, 'Brooklyn');
  });

  it('drops rows without a title, link or start time; tolerates missing image', () => {
    assert.equal(parks.mapSocrataRow({ ...parksRow, title: ' ' }), null);
    assert.equal(parks.mapSocrataRow({ ...parksRow, link: undefined }), null);
    assert.equal(parks.mapSocrataRow({ ...parksRow, starttime: undefined }), null);
    assert.deepEqual(parks.mapSocrataRow({ ...parksRow, image: undefined }).images, []);
  });
});

describe('nyc-opendata permitted events', () => {
  it('builds a $where with offset-less NYC timestamps and the type filter', () => {
    const where = opendata.buildPermittedWhere(new Date('2026-10-01T02:00:00Z'), 60);
    assert.match(where, /start_date_time >= '2026-09-30T22:00:00'/); // EDT = UTC-4
    assert.match(where, /start_date_time <= '2026-11-29T21:00:00'/); // EST = UTC-5
    assert.doesNotMatch(where, /Z'/);
    assert.match(where, /event_type in\('Farmers Market', /);
    assert.doesNotMatch(where, /Sport - Youth|Special Event/);
  });

  const row = {
    event_id: '950351',
    event_name: 'Brooklyn Columbus Day Parade',
    start_date_time: '2026-10-11T13:00:00.000',
    end_date_time: '2026-10-11T16:00:00.000',
    event_agency: 'Police Department',
    event_type: 'Parade',
    event_borough: 'Brooklyn',
    event_location: '18 Avenue between 61 Street and 83 Street',
  };

  it('maps an allowed row', () => {
    const e = opendata.mapPermittedEvent(row);
    assert.equal(e.title, 'Brooklyn Columbus Day Parade');
    assert.equal(e.startDate, '2026-10-11T13:00:00.000');
    assert.equal(e.location.address, '18 Avenue between 61 Street and 83 Street');
    assert.equal(e.borough, 'Brooklyn');
    assert.deepEqual(e.categories, ['Parade']);
  });

  it('drops noise types, private permits and rows without a start', () => {
    assert.equal(opendata.mapPermittedEvent({ ...row, event_type: 'Sport - Youth' }), null);
    assert.equal(opendata.mapPermittedEvent({ ...row, event_type: 'Special Event' }), null);
    assert.equal(opendata.mapPermittedEvent({ ...row, event_type: undefined }), null);
    assert.equal(opendata.mapPermittedEvent({ ...row, event_name: 'Oval Lawn Closure' }), null);
    assert.equal(opendata.mapPermittedEvent({ ...row, start_date_time: undefined }), null);
  });

  it('dedupes repeated event_id rows, keeping the first', () => {
    const rows = [row, { ...row, event_location: 'other' }, { ...row, event_id: '2' }];
    const out = opendata.dedupeByEventId(rows);
    assert.equal(out.length, 2);
    assert.equal(out[0].event_location, row.event_location);
  });
});
