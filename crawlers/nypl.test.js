import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// The crawler imports lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

let nypl, generateEventId;
before(async () => {
  nypl = await import('./nypl.js');
  ({ generateEventId } = await import('../lib/base-crawler.js'));
});

// ── Trimmed copies of real drupal.nypl.org/jsonapi responses ──────

// date/event occurrence (title carries the per-session suffix NYPL appends)
const occurrenceNode = {
  type: 'date--event',
  id: 'f1bd67e6-313a-47d6-b8c0-f2be6043c662',
  attributes: {
    drupal_internal__id: 404707,
    title: 'High Beginner Level English Conversation Classes: We Speak NYC (Occurrence 3) - 10/11/2026 | 10:00am',
    field_event_date: {
      value: '2026-10-11T14:00:00+00:00',
      end_value: '2026-10-11T15:00:00+00:00',
      duration: null, rrule: null, rrule_index: null, timezone: null,
    },
    field_ts_date_status: null,
    field_ts_cancellation_reason: null,
    field_registration: null,
  },
  relationships: {
    date_type: { data: { type: 'date_type--date_type', id: '36950489-336b-4218-8387-faf07a231ac2' } },
    field_ers_parent_event: { data: { type: 'node--event', id: 'd7fcd85c-becc-433d-a29c-163cd85f52a2', meta: { drupal_internal__target_id: 233196 } } },
  },
};

// node/event parent with its location/library/image/type includes
const parentPayload = {
  data: {
    type: 'node--event',
    id: 'd7fcd85c-becc-433d-a29c-163cd85f52a2',
    attributes: {
      title: 'High Beginner Level English Conversation Classes: We Speak NYC',
      field_lt_event_format: 'in_person',
      path: { alias: '/events/programs/2026/10/11/high-beginner-level-english-conversation-classes-we-speak-nyc', pid: 234140, langcode: 'en' },
      body: { value: '<p>This event will take place IN PERSON at the Stavros Niarchos Foundation Library, 6th floor, Room 602.</p><h3>HIGH BEGINNER</h3>' },
      field_tfls_summary_description: { value: 'This event will take place IN PERSON at the Stavros Niarchos Foundation Library.' },
    },
    relationships: {
      // event_location is a repeated relationship on real NYPL nodes — data is an array.
      field_erm_event_location: { data: [{ type: 'paragraph--event_location', id: 'pl-1' }] },
      field_ers_media_image: { data: { type: 'media--image', id: 'm-1' } },
      field_erm_event_type: { data: { type: 'taxonomy_term--event_type', id: 't-1' } },
    },
  },
  included: [
    {
      type: 'paragraph--event_location',
      id: 'pl-1',
      attributes: { field_ts_external_location: null, field_bool_both_locations: false },
      relationships: { field_erm_event_location: { data: { type: 'node--library', id: 'lib-1' } } },
    },
    {
      type: 'node--library',
      id: 'lib-1',
      attributes: {
        title: 'Stavros Niarchos Foundation Library (SNFL)',
        field_as_address: { langcode: 'en', country_code: 'US', administrative_area: 'NY', locality: 'New York', postal_code: '10016', address_line1: '455 Fifth Avenue', address_line3: '' },
        field_geos_coordinates: { lat: 40.752, lng: -73.9818, value: '40.752, -73.9818' },
        field_ts_location_code: 'sn',
      },
    },
    { type: 'taxonomy_term--event_type', id: 't-1', attributes: { name: 'Classes/Workshops' } },
    {
      type: 'media--image',
      id: 'm-1',
      attributes: { name: 'We Speak NYC' },
      relationships: { field_media_image: { data: { type: 'file--file', id: 'f-1' } } },
    },
    { type: 'file--file', id: 'f-1', attributes: { uri: { value: 'public://2026-07/we speak.jpg' }, url: '/sites-drupal/default/files/2026-07/we%20speak.jpg', filename: 'we speak.jpg' } },
  ],
};

// An online program with no branch location (external location only).
const onlinePayload = {
  data: {
    type: 'node--event',
    id: 'online-1',
    attributes: { title: 'Online Book Club', field_lt_event_format: 'online', path: { alias: '/events/programs/2026/10/12/online-book-club' }, body: { value: '<p>Join us online.</p>' } },
    relationships: { field_erm_event_location: { data: [{ type: 'paragraph--event_location', id: 'pl-2' }] } },
  },
  included: [
    {
      type: 'paragraph--event_location',
      id: 'pl-2',
      attributes: { field_ts_external_location: 'Online via Google Hangouts Meet', field_bool_both_locations: false },
      relationships: {},
    },
  ],
};

const canceledOccurrence = {
  ...occurrenceNode,
  id: 'cancel-1',
  attributes: { ...occurrenceNode.attributes, field_ts_date_status: 'canceled' },
};

describe('nypl titleFromOccurrence', () => {
  it('strips the occurrence index and the date|time suffix', () => {
    assert.equal(
      nypl.titleFromOccurrence('Help on The Way Inc. (Occurrence 7) - 10/11/2026 | 10:00am'),
      'Help on The Way Inc.',
    );
    assert.equal(
      nypl.titleFromOccurrence('Family Storytime - 10/12/2026 | 11:30am'),
      'Family Storytime',
    );
    assert.equal(
      nypl.titleFromOccurrence('Typing Between the Lines (Occurrence 12) - 10/13/2026 | 2:00pm'),
      'Typing Between the Lines',
    );
    assert.equal(nypl.titleFromOccurrence('Plain Title'), 'Plain Title');
  });
});

describe('nypl parseOccurrence', () => {
  it('reads the instant, parent and title from a real row', () => {
    const occ = nypl.parseOccurrence(occurrenceNode);
    assert.equal(occ.startMs, Date.parse('2026-10-11T14:00:00Z'));
    assert.equal(occ.endMs, Date.parse('2026-10-11T15:00:00Z'));
    assert.equal(occ.parentId, 'd7fcd85c-becc-433d-a29c-163cd85f52a2');
    assert.equal(occ.canceled, false);
  });

  it('flags canceled sessions', () => {
    assert.equal(nypl.parseOccurrence(canceledOccurrence).canceled, true);
  });

  it('drops rows without a date or a parent', () => {
    assert.equal(nypl.parseOccurrence({ attributes: {}, relationships: {} }), null);
    assert.equal(nypl.parseOccurrence({ attributes: { field_event_date: { value: '2026-10-11T14:00:00+00:00' } }, relationships: {} }), null);
    // A bare date is not an instant and must not be treated as one.
    assert.equal(nypl.parseOccurrence({ attributes: { field_event_date: { value: '2026-10-11' } }, relationships: { field_ers_parent_event: { data: { type: 'node--event', id: 'x' } } } }), null);
  });
});

describe('nypl occurrenceInWindow', () => {
  const now = Date.parse('2026-10-11T00:00:00Z');
  const cutoff = now + 14 * 86400000;
  it('keeps only in-window, non-canceled occurrences', () => {
    const occ = nypl.parseOccurrence(occurrenceNode);
    assert.equal(nypl.occurrenceInWindow(occ, now, cutoff), true);
    assert.equal(nypl.occurrenceInWindow({ ...occ, startMs: now - 1 }, now, cutoff), false);
    assert.equal(nypl.occurrenceInWindow({ ...occ, startMs: cutoff + 1 }, now, cutoff), false);
    assert.equal(nypl.occurrenceInWindow({ ...occ, canceled: true }, now, cutoff), false);
    assert.equal(nypl.occurrenceInWindow(null, now, cutoff), false);
  });
});

describe('nypl mapParentResource', () => {
  it('pulls title, body, path, type, branch address and image out of the includes', () => {
    const p = nypl.mapParentResource(parentPayload);
    assert.equal(p.title, 'High Beginner Level English Conversation Classes: We Speak NYC');
    assert.match(p.description, /Stavros Niarchos Foundation Library/);
    assert.ok(!p.description.includes('<'), 'markup must be stripped');
    assert.equal(p.format, 'in_person');
    assert.equal(p.pathAlias, '/events/programs/2026/10/11/high-beginner-level-english-conversation-classes-we-speak-nyc');
    assert.equal(p.typeName, 'Classes/Workshops');
    assert.equal(p.location.name, 'Stavros Niarchos Foundation Library (SNFL)');
    assert.equal(p.location.address, '455 Fifth Avenue, New York, NY 10016');
    assert.equal(p.location.city, 'New York');
    assert.equal(p.location.lat, 40.752);
    assert.equal(p.location.lng, -73.9818);
    assert.deepEqual(p.images, ['https://www.nypl.org/sites-drupal/default/files/2026-07/we%20speak.jpg']);
  });

  it('falls back to the external location for an online program', () => {
    const p = nypl.mapParentResource(onlinePayload);
    assert.equal(p.format, 'online');
    assert.equal(p.location.name, 'Online via Google Hangouts Meet');
    assert.equal(p.location.address, null);
    assert.equal(p.location.lat, null);
    assert.deepEqual(p.images, []);
  });

  it('resolves the branch name through the array location relationship', () => {
    // Regression: field_erm_event_location is an ARRAY relationship on real nodes;
    // reading .data.id (not .data[0].id) silently fell back to the generic venue
    // name and dropped the address/coords for every branch event.
    const arrayShape = structuredClone(parentPayload);
    arrayShape.data.relationships.field_erm_event_location = { data: arrayShape.data.relationships.field_erm_event_location.data };
    const p = nypl.mapParentResource(arrayShape);
    assert.equal(p.location.name, 'Stavros Niarchos Foundation Library (SNFL)');
    assert.equal(p.location.lat, 40.752);
  });

  it('returns null for a non-event resource', () => {
    assert.equal(nypl.mapParentResource({ data: { type: 'node--library' } }), null);
    assert.equal(nypl.mapParentResource(null), null);
  });
});

describe('nypl mapOccurrence', () => {
  const occ = () => nypl.parseOccurrence(occurrenceNode);
  const parent = () => nypl.mapParentResource(parentPayload);

  it('maps a session to the shared event shape', () => {
    const e = nypl.mapOccurrence(occ(), parent());
    assert.equal(e.source, 'New York Public Library');
    assert.equal(e.title, 'High Beginner Level English Conversation Classes: We Speak NYC');
    assert.equal(e.sourceUrl, 'https://www.nypl.org/events/programs/2026/10/11/high-beginner-level-english-conversation-classes-we-speak-nyc');
    assert.equal(e.ticketUrl, e.sourceUrl);
    assert.equal(e.organizer, 'New York Public Library');
    assert.equal(e.attendance, null);
    assert.equal(e.rawText, null);
  });

  it('keeps the real instants and formats the NYC time range', () => {
    const e = nypl.mapOccurrence(occ(), parent());
    assert.equal(e.startDate, '2026-10-11T14:00:00.000Z'); // 10:00 AM EDT
    assert.equal(e.endDate, '2026-10-11T15:00:00.000Z');   // 11:00 AM EDT
    assert.equal(e.time, '10:00 AM–11:00 AM');
  });

  it('falls back to a single clock label and null end date', () => {
    const noEnd = { ...occ(), endMs: null };
    const e = nypl.mapOccurrence(noEnd, parent());
    assert.equal(e.endDate, null);
    assert.equal(e.time, '10:00 AM');
  });

  it('carries the branch as venue/neighborhood and the event type as category', () => {
    const e = nypl.mapOccurrence(occ(), parent());
    assert.equal(e.location.name, 'Stavros Niarchos Foundation Library (SNFL)');
    assert.equal(e.location.address, '455 Fifth Avenue, New York, NY 10016');
    assert.equal(e.neighborhood, 'Murray Hill'); // derived from the branch ZIP 10016
    assert.equal(e.borough, 'Manhattan');
    assert.deepEqual(e.categories, ['Classes/Workshops']);
    assert.deepEqual(e.tags, ['library', 'in-person']);
  });

  it('derives the borough from the branch address for every borough', () => {
    const bronx = structuredClone(parentPayload);
    bronx.included.find((i) => i.type === 'node--library').attributes.field_as_address = {
      administrative_area: 'NY', locality: 'Bronx', postal_code: '10457', address_line1: '155 East 173rd Street',
    };
    const e = nypl.mapOccurrence(occ(), nypl.mapParentResource(bronx));
    assert.equal(e.borough, 'Bronx');
  });

  it('is always free and tags online programs', () => {
    const e = nypl.mapOccurrence(occ(), parent());
    assert.deepEqual(e.price, { isFree: true, min: 0, max: 0, currency: 'USD' });
    const online = nypl.mapOccurrence(occ(), nypl.mapParentResource(onlinePayload));
    assert.deepEqual(online.tags, ['library', 'online']);
  });

  it('images the poster when the program has one', () => {
    const e = nypl.mapOccurrence(occ(), parent());
    assert.deepEqual(e.images, ['https://www.nypl.org/sites-drupal/default/files/2026-07/we%20speak.jpg']);
  });

  it('keys the id on program url + occurrence start, so sessions differ', () => {
    const e = nypl.mapOccurrence(occ(), parent());
    const expected = generateEventId(
      'https://www.nypl.org/events/programs/2026/10/11/high-beginner-level-english-conversation-classes-we-speak-nyc#2026-10-11T14:00:00.000Z',
      'High Beginner Level English Conversation Classes: We Speak NYC',
    );
    assert.equal(e.id, expected);
    const later = nypl.mapOccurrence({ ...occ(), startMs: Date.parse('2026-10-18T14:00:00Z') }, parent());
    assert.notEqual(e.id, later.id);
  });

  it('returns null without an occurrence or a parent', () => {
    assert.equal(nypl.mapOccurrence(null, parent()), null);
    assert.equal(nypl.mapOccurrence(occ(), null), null);
  });
});

describe('nypl request URLs', () => {
  it('pages the occurrence index with a unix BETWEEN filter', () => {
    const url = nypl.occurrencePageUrl(1791676800, 1792886400, 50);
    assert.match(url, /^https:\/\/drupal\.nypl\.org\/jsonapi\/date\/event\?/);
    const q = new URL(url).searchParams;
    assert.equal(q.get('sort'), 'field_event_date.value');
    assert.equal(q.get('page[offset]'), '50');
    // The operator must be BETWEEN on the nested .value path with two unix stamps —
    // a bare date string silently matches every row on this Drupal field.
    assert.equal(q.get('filter[r][condition][operator]'), 'BETWEEN');
    assert.equal(q.get('filter[r][condition][path]'), 'field_event_date.value');
    assert.deepEqual(q.getAll('filter[r][condition][value][]'), ['1791676800', '1792886400']);
    assert.match(q.get('fields[date--event]'), /field_ers_parent_event/);
  });

  it('fetches a parent with its location/image/type includes', () => {
    const q = new URL(nypl.parentUrl('abc')).searchParams;
    assert.match(q.get('include'), /field_erm_event_location\.field_erm_event_location/);
    assert.match(q.get('include'), /field_ers_media_image\.field_media_image/);
    assert.match(q.get('include'), /field_erm_event_type/);
  });
});
