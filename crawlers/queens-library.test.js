import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// The crawler imports lib/supabase.js, which requires these; no request is made in these tests.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'test-key';

let ql;
before(async () => {
  ql = await import('./queens-library.js');
});

/** Rebuilds the page's `arrJsonData_cal['<jobID>'] = '<json with &quot;>';` statement. */
function statement(program) {
  return `arrJsonData_cal['${program.jobID}'] = '${JSON.stringify(program).replace(/"/g, '&quot;')}';`;
}

const sha16 = (value) => crypto.createHash('sha256').update(value).digest('hex').substring(0, 16);

const session = (ts, minutes, branch, roomID) => ({
  jobID: '000602-07/26',
  index: `${ts}-${roomID}`,
  timestamp_GMT: ts,
  date_time: '10/01/26   1:30PM',
  duration: minutes * 60,
  date_time_format: 'Oct, 1, 1:30pm - 3:30pm',
  location: { virtua: '93200000', branch },
  roomID,
  registration: { is_active: false, wait: null, available_spots: null, not_active_reason: null },
});

// Real program 000602-0726 (Creative Aging: Landscape Explorations, Elmhurst).
const creativeAging = {
  jobID: '000602-0726',
  title: 'Creative Aging: Landscape Explorations',
  descr: 'During this 6-week workshop series we will explore the landscape tradition. We will consider how landscapes are int...',
  callUrl: '/calendar/creative-aging-landscape-explorations/000602-0726',
  prgm_image: '000602-07-26_Gouache_Art_0926_259x396_Event.jpg',
  prgm_age: 'Adults, Seniors',
  delivery_format: 'In-Person',
  prgm_type: 'Adult Program, General',
  branch_name: 'Elmhurst',
  date_show: 'Oct 1, 1:30pm - 3:30pm',
  other_sessions: {
    '1790875800-438': session(1790875800, 120, 'Elmhurst', 438),
    '1791480600-438': session(1791480600, 120, 'Elmhurst', 438),
    '1792085400-438': session(1792085400, 120, 'Elmhurst', 438),
    '1792690200-438': session(1792690200, 120, 'Elmhurst', 438),
    '1793295000-438': session(1793295000, 120, 'Elmhurst', 438),
  },
};

// Real program 017823-0526 (Crochet Club, Kew Gardens Hills) — trimmed to two sessions.
const crochet = {
  jobID: '017823-0526',
  title: 'Crochet Club',
  descr: 'Crocheters of all skill levels are invited to join the Kew Gardens Hills Crochet Club! Please bring yarn and a croc...',
  callUrl: '/calendar/crochet-club/017823-0526',
  prgm_image: '005730-10-25_Crochet Adult_259x396_event2.jpg',
  prgm_age: 'Adults',
  delivery_format: 'In-Person',
  prgm_type: 'Adult Program, General',
  branch_name: 'Kew Gardens Hills',
  date_show: 'Oct 1, 1:30pm - 3:00pm',
  other_sessions: {
    '1790875800-233': session(1790875800, 90, 'Kew Gardens Hills', 233),
    '1791480600-233': session(1791480600, 90, 'Kew Gardens Hills', 233),
  },
};

const PAGE_HTML = `<html><head><script>
${statement(creativeAging)}
${statement(crochet)}
</script></body></html>`;

// Now = 2026-09-25T12:00Z; the 14-day window ends 2026-10-09T12:00Z.
const NOW = new Date('2026-09-25T12:00:00Z');

describe('queens-library parsePrograms', () => {
  it('reads every arrJsonData_cal statement out of a calendar page', () => {
    const programs = ql.parsePrograms(PAGE_HTML);
    assert.equal(programs.length, 2);
    assert.deepEqual(programs.map(p => p.jobID), ['000602-0726', '017823-0526']);
    assert.equal(programs[0].title, 'Creative Aging: Landscape Explorations');
    assert.equal(programs[1].branch_name, 'Kew Gardens Hills');
    assert.equal(programs[0].other_sessions['1790875800-438'].duration, 7200);
  });

  it('skips statements with unparsable JSON and copes with empty input', () => {
    const html = `arrJsonData_cal['000602-0726'] = '{&quot;jobID&quot;:';` + statement(crochet);
    const programs = ql.parsePrograms(html);
    assert.equal(programs.length, 1);
    assert.equal(programs[0].jobID, '017823-0526');
    assert.deepEqual(ql.parsePrograms(''), []);
    assert.deepEqual(ql.parsePrograms(undefined), []);
    assert.deepEqual(ql.parsePrograms('<html>no programs here</html>'), []);
  });
});

describe('queens-library shouldSkip', () => {
  it('keeps in-person library programs', () => {
    assert.equal(ql.shouldSkip(creativeAging), false);
    assert.equal(ql.shouldSkip(crochet), false);
    assert.equal(ql.shouldSkip({ prgm_type: 'Adult Program, General' }), false);
  });

  it('drops virtual-only programs and the low-value program types', () => {
    assert.equal(ql.shouldSkip({ ...creativeAging, delivery_format: 'Virtual' }), true);
    assert.equal(ql.shouldSkip({ ...creativeAging, prgm_type: 'Computer Classes, Adult Program' }), true);
    assert.equal(ql.shouldSkip({ ...creativeAging, prgm_type: 'ESOL, Adult Program' }), true);
    assert.equal(ql.shouldSkip({ ...creativeAging, prgm_type: 'Adult Program, Citizenship' }), true);
    assert.equal(ql.shouldSkip({ ...creativeAging, prgm_type: 'Coping Skills' }), true);
    assert.equal(ql.shouldSkip({ ...creativeAging, prgm_type: 'Job Search, Adult Program' }), true);
    assert.equal(ql.shouldSkip({ ...creativeAging, prgm_type: 'Health Insurance' }), true);
    assert.equal(ql.shouldSkip({ ...creativeAging, prgm_type: 'Tax Preparation' }), true);
    assert.equal(ql.shouldSkip({ ...creativeAging, prgm_type: 'Financial Literacy' }), true);
    assert.equal(ql.shouldSkip({ ...creativeAging, prgm_type: 'Support Group' }), true);
    assert.equal(ql.shouldSkip({ ...creativeAging, prgm_type: undefined }), false);
  });
});

describe('queens-library mapProgram', () => {
  it('expands a program into one event per session in the next 14 days', () => {
    const events = ql.mapProgram(creativeAging, NOW);
    assert.equal(events.length, 2); // Oct 1 and 8; Oct 15 is past the 14-day window
    assert.deepEqual(events.map(e => e.startDate), [
      '2026-10-01T17:30:00.000Z',
      '2026-10-08T17:30:00.000Z',
    ]);
  });

  it('maps a session to the shared event shape', () => {
    const [e] = ql.mapProgram(creativeAging, NOW);
    const sourceUrl = 'https://www.queenslibrary.org/calendar/creative-aging-landscape-explorations/000602-0726';

    assert.equal(e.source, 'Queens Public Library');
    assert.equal(e.organizer, 'Queens Public Library');
    assert.equal(e.borough, 'Queens');
    assert.equal(e.sourceUrl, sourceUrl);
    assert.equal(e.ticketUrl, sourceUrl);
    assert.equal(e.title, 'Creative Aging: Landscape Explorations');
    assert.equal(e.id, sha16(`${sourceUrl}#1790875800-Creative Aging: Landscape Explorations`));
    assert.equal(e.startDate, '2026-10-01T17:30:00.000Z');
    assert.equal(e.endDate, '2026-10-01T19:30:00.000Z'); // +7200s
    assert.equal(e.time, '1:30 PM–3:30 PM');
    assert.equal(e.location.name, 'Elmhurst Library');
    assert.equal(e.location.city, 'New York');
    assert.equal(e.location.lat, null);
    assert.equal(e.location.lng, null);
    assert.equal(e.neighborhood, 'Elmhurst');
    assert.deepEqual(e.price, { isFree: true, min: 0, max: 0, currency: 'USD' });
    assert.deepEqual(e.categories, ['Adult Program', 'General']);
    assert.deepEqual(e.tags, ['library', 'Adults, Seniors']);
    assert.deepEqual(e.images, ['https://image.queenslibrary.org/lamps/styles/event_small/000602-07-26_Gouache_Art_0926_259x396_Event.jpg']);
    assert.match(e.description, /During this 6-week workshop series/);
    assert.equal(e.attendance, null);
    assert.equal(e.rawText, null);
  });

  it('formats a 90-minute session and gives each session its own id', () => {
    const events = ql.mapProgram(crochet, NOW);
    assert.equal(events.length, 2);
    assert.equal(events[0].time, '1:30 PM–3:00 PM');
    assert.equal(events[0].endDate, '2026-10-01T19:00:00.000Z');
    assert.equal(events[0].location.name, 'Kew Gardens Hills Library');
    assert.equal(events[0].neighborhood, 'Kew Gardens Hills');
    assert.deepEqual(events[0].tags, ['library', 'Adults']);
    assert.notEqual(events[0].id, events[1].id);
  });

  it('drops sessions already started and leaves programs without a title, image or sessions empty', () => {
    assert.equal(ql.mapProgram(creativeAging, new Date('2026-10-16T12:00:00Z')).length, 2); // Oct 22, Oct 29
    assert.equal(ql.mapProgram(creativeAging, new Date('2026-11-10T12:00:00Z')).length, 0); // nothing left
    assert.deepEqual(ql.mapProgram({ ...creativeAging, title: '  ' }, NOW), []);
    assert.deepEqual(ql.mapProgram({ ...creativeAging, other_sessions: {} }, NOW), []);
    assert.deepEqual(ql.mapProgram({ ...creativeAging, other_sessions: undefined }, NOW), []);
    assert.deepEqual(ql.mapProgram({ ...creativeAging, other_sessions: { x: { duration: 3600 } } }, NOW), []);
  });

  it('skips virtual-only programs and tolerates a missing image or branch', () => {
    assert.deepEqual(ql.mapProgram({ ...creativeAging, delivery_format: 'Virtual' }, NOW), []);

    const [noImage] = ql.mapProgram({ ...creativeAging, prgm_image: '' }, NOW);
    assert.deepEqual(noImage.images, []);
    assert.deepEqual(noImage.tags, ['library', 'Adults, Seniors']);

    const noBranchSession = {
      ...creativeAging,
      branch_name: 'Woodside',
      other_sessions: { '1790875800-438': { timestamp_GMT: 1790875800, duration: 7200, location: {} } },
    };
    const [fallback] = ql.mapProgram(noBranchSession, NOW);
    assert.equal(fallback.location.name, 'Woodside Library');
    assert.equal(fallback.neighborhood, 'Woodside');
    assert.equal(fallback.endDate, '2026-10-01T19:30:00.000Z');
    assert.equal(fallback.time, '1:30 PM–3:30 PM');
  });

  it('accepts a string timestamp and drops a session with no end time', () => {
    const stringy = {
      ...creativeAging,
      other_sessions: { s: { timestamp_GMT: '1790875800', duration: 5400 } },
    };
    const [e] = ql.mapProgram(stringy, NOW);
    assert.equal(e.startDate, '2026-10-01T17:30:00.000Z');
    assert.equal(e.endDate, '2026-10-01T19:00:00.000Z');

    const noDuration = { ...creativeAging, other_sessions: { s: { timestamp_GMT: 1790875800 } } };
    const [single] = ql.mapProgram(noDuration, NOW);
    assert.equal(single.endDate, null);
    assert.equal(single.time, '1:30 PM');
    assert.equal(single.location.name, 'Elmhurst Library');
  });
});

describe('queens-library formatTimeRange', () => {
  it('renders NYC wall-clock labels, including midnight and a single instant', () => {
    assert.equal(ql.formatTimeRange(Date.parse('2026-10-01T17:30:00Z'), Date.parse('2026-10-01T19:30:00Z')), '1:30 PM–3:30 PM');
    assert.equal(ql.formatTimeRange(Date.parse('2026-10-01T17:30:00Z'), null), '1:30 PM');
    assert.equal(ql.formatTimeRange(Date.parse('2026-10-01T04:00:00Z'), Date.parse('2026-10-01T05:00:00Z')), '12:00 AM–1:00 AM');
    assert.equal(ql.formatTimeRange(Date.parse('2026-10-01T14:00:00Z'), Date.parse('2026-10-01T14:00:00Z')), '10:00 AM');
    assert.equal(ql.formatTimeRange(NaN, Date.now()), null);
    assert.doesNotMatch(ql.formatTimeRange(Date.parse('2026-10-01T17:30:00Z'), Date.parse('2026-10-01T19:30:00Z')), /[\u202f\u00a0]/);
  });
});