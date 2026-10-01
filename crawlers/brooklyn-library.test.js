import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// The crawler imports lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

let bpl, generateEventId;
before(async () => {
  bpl = await import('./brooklyn-library.js');
  ({ generateEventId } = await import('../lib/base-crawler.js'));
});

// Trimmed copies of sample.tmp.json docs (search API, event=true)
const dropInDoc = {
  id: 'drupal_node_834664',
  ss_item_id: '834664',
  ts_title: 'Drop In Resume and Career Help',
  ts_body: '<p>Stop by Flatbush Library for help with your resume, cover letter, interview, and job search questions. All sessions are one-on-one on a first come, first served basis.</p>',
  ds_created: '2026-07-08T18:12:24Z',
  ds_changed: '2026-09-30T14:30:02Z',
  ds_event_start_date: '2026-09-30T14:30:00Z',
  ds_event_end_date: '2026-10-01T03:30:00Z',
  ss_event_location: 'Flatbush Library',
  is_virtual: 0,
  ss_image_url: 'https://static.bklynlibrary.org/prod/public/images/events/calendar/resume_help.png',
  tm_event_tags: ['career', 'resume'],
  ss_type: 'event',
  ts_event_age: 'Adults',
  is_event_registration: 0,
  is_event_canceled: 0,
};

const socialWorkDoc = {
  id: 'drupal_node_819764',
  ss_item_id: '819764',
  ts_title: 'Social Work Walk-In Hours',
  ts_body: '<p>Brooklyn Public Library\'s&nbsp;Social Work Program will be available to assist with referrals for:</p><ul style="list-style-type:disc;"><li>Housing Assistance</li><li>Food Assistance</li></ul><p>Appointments are free and limited to 30 minutes. &nbsp;</p>',
  ds_event_start_date: '2026-10-01T14:00:00Z',
  ds_event_end_date: '2026-10-01T19:00:00Z',
  ss_event_location: 'Central Library, Civic Commons Partner Office',
  is_virtual: 0,
  ss_image_url: 'https://static.bklynlibrary.org/prod/public/images/events/calendar/brooklyn_supports_hands.jpeg',
  tm_event_tags: ['benefit assistance', 'Healthy Communities', 'social services'],
  ts_event_age: 'Adults',
  is_event_registration: 0,
  is_event_canceled: 0,
};

const sbdcDoc = {
  id: 'drupal_node_828661',
  ss_item_id: '828661',
  ts_title: 'Pace SBDC Business Counseling @ BPL',
  ts_body: '<p>The&nbsp;Pace University Small Business Development Center (SBDC) is offering weekly, free, in-person one-to-one business advisement at the&nbsp;Brooklyn Public Library\u2019s Business &amp; Career Center!</p><p>Get help on access to financing, marketing and sales strategies, government procurement, and business planning.</p>',
  ds_event_start_date: '2026-10-01T14:00:00Z',
  ds_event_end_date: '2026-10-01T21:00:00Z',
  ss_event_location: 'Central Library, Business &amp; Career Center',
  ss_event_location_master: 'Central Library, Business &amp; Career Center',
  is_virtual: 0,
  ss_image_url: 'https://static.bklynlibrary.org/prod/public/images/events/calendar/blackwomendiscussing_2.jpg',
  tm_event_tags: ['business', 'small business'],
  ss_type: 'event',
  ts_event_age: 'Adults',
  is_event_registration: 0,
  is_event_canceled: 0,
};

const searchPage = {
  grouped: {
    ss_grouping: {
      matches: 7015,
      groups: [dropInDoc, socialWorkDoc, sbdcDoc].map(doc => ({ doclist: { docs: [doc] } })),
    },
  },
};

describe('brooklyn-library extractDocs', () => {
  it('takes the single doc out of every grouping group', () => {
    const docs = bpl.extractDocs(searchPage);
    assert.equal(docs.length, 3);
    assert.deepEqual(docs.map(d => d.ss_item_id), ['834664', '819764', '828661']);
  });

  it('tolerates an empty or unexpected payload', () => {
    assert.deepEqual(bpl.extractDocs({ grouped: { ss_grouping: { groups: [] } } }), []);
    assert.deepEqual(bpl.extractDocs({ error: 'access denied' }), []);
    assert.deepEqual(bpl.extractDocs({ grouped: { ss_grouping: { groups: [{}, { doclist: { docs: [] } }] } } }), []);
  });
});

describe('brooklyn-library shouldSkip', () => {
  it('keeps real programs', () => {
    assert.equal(bpl.shouldSkip(sbdcDoc), false);
    assert.equal(bpl.shouldSkip({ ...sbdcDoc, ts_title: 'Baby Rhyme Time' }), false);
  });

  it('skips cancelled and virtual events', () => {
    assert.equal(bpl.shouldSkip({ ...sbdcDoc, is_event_canceled: 1 }), true);
    assert.equal(bpl.shouldSkip({ ...sbdcDoc, is_virtual: 1 }), true);
  });

  it('skips recurring drop-in service sessions', () => {
    for (const ts_title of [
      'Drop In Resume and Career Help',
      'Social Work Walk-In Hours',
      'Drop-in Tech Help',
      'One-on-One Career Help',
      'Social Worker Office Hours',
      'Tax Prep Workshop',
      'Free Tax Help',
      'ESOL Class',
      'ESL Conversation Group',
      'English Conversation Circle',
      'Citizenship Class',
      'Job Search Lab',
      'Computer Help Drop-in',
      'Job Search Lab',
    ]) {
      assert.equal(bpl.shouldSkip({ ...sbdcDoc, ts_title }), true, ts_title);
    }
  });

  it('skips a missing doc', () => {
    assert.equal(bpl.shouldSkip(null), true);
  });
});

describe('brooklyn-library mapDoc', () => {
  const mapped = () => bpl.mapDoc(sbdcDoc);

  it('maps a doc to the shared event shape', () => {
    const e = mapped();
    assert.equal(e.source, 'Brooklyn Public Library');
    assert.equal(e.title, 'Pace SBDC Business Counseling @ BPL');
    assert.equal(e.sourceUrl, 'https://www.bklynlibrary.org/node/828661');
    assert.equal(e.ticketUrl, 'https://www.bklynlibrary.org/node/828661');
    assert.equal(e.organizer, 'Brooklyn Public Library');
    assert.equal(e.borough, 'Brooklyn');
    assert.equal(e.attendance, null);
    assert.equal(e.rawText, null);
  });

  it('keeps the API instants and formats the NYC time range', () => {
    const e = mapped();
    assert.equal(e.startDate, '2026-10-01T14:00:00.000Z'); // 10:00 AM EDT
    assert.equal(e.endDate, '2026-10-01T21:00:00.000Z');   // 5:00 PM EDT
    assert.equal(e.time, '10:00 AM–5:00 PM');
  });

  it('falls back to a single clock label and null end date', () => {
    const noEnd = bpl.mapDoc({ ...sbdcDoc, ds_event_end_date: undefined });
    assert.equal(noEnd.endDate, null);
    assert.equal(noEnd.time, '10:00 AM');
  });

  it('strips markup and decodes entities from the body and branch', () => {
    const e = mapped();
    assert.ok(!e.description.includes('<'));
    assert.ok(e.description.includes('Brooklyn Public Library’s Business & Career Center'));
    assert.ok(e.description.startsWith('The Pace University Small Business Development Center'));
    assert.ok(!e.description.includes('&nbsp;'), 'nbsp must not survive');
    assert.equal(e.location.name, 'Central Library, Business & Career Center');
    assert.equal(e.neighborhood, 'Central Library, Business & Career Center');
    assert.equal(e.location.city, 'New York');
    assert.equal(e.location.lat, null);
    assert.equal(e.location.address, null);
  });

  it('is always free and tags library + age + registration', () => {
    const e = mapped();
    assert.deepEqual(e.price, { isFree: true, min: 0, max: 0, currency: 'USD' });
    assert.deepEqual(e.categories, ['business', 'small business']);
    assert.deepEqual(e.tags, ['library', 'Adults']);
    assert.deepEqual(
      bpl.mapDoc({ ...sbdcDoc, is_event_registration: 1 }).tags,
      ['library', 'Adults', 'registration-required'],
    );
    assert.deepEqual(bpl.mapDoc({ ...sbdcDoc, ts_event_age: '' }).tags, ['library']);
  });

  it('images the poster when the doc has one', () => {
    assert.deepEqual(
      mapped().images,
      ['https://static.bklynlibrary.org/prod/public/images/events/calendar/blackwomendiscussing_2.jpg'],
    );
    assert.deepEqual(bpl.mapDoc({ ...sbdcDoc, ss_image_url: '' }).images, []);
  });

  it('keys the id on node + start date, since one node repeats weekly', () => {
    const e = mapped();
    assert.equal(e.id, generateEventId('https://www.bklynlibrary.org/node/828661#2026-10-01T14:00:00Z', sbdcDoc.ts_title));
    assert.notEqual(e.id, bpl.mapDoc({ ...sbdcDoc, ds_event_start_date: '2026-10-08T14:00:00Z' }).id);
  });

  it('drops skipped docs and anything without a title, node id or start', () => {
    assert.equal(bpl.mapDoc(dropInDoc), null);
    assert.equal(bpl.mapDoc(socialWorkDoc), null);
    assert.equal(bpl.mapDoc({ ...sbdcDoc, is_event_canceled: 1 }), null);
    assert.equal(bpl.mapDoc({ ...sbdcDoc, ts_title: '   ' }), null);
    assert.equal(bpl.mapDoc({ ...sbdcDoc, ss_item_id: undefined }), null);
    assert.equal(bpl.mapDoc({ ...sbdcDoc, ds_event_start_date: undefined }), null);
  });
});
