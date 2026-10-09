import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chainable fake of the supabase client. Every call is recorded; awaiting a
// chain (or .maybeSingle()/.single()) resolves to the response picked by `respond`.
const calls = [];
let respond = () => ({ data: null, error: null });

function chain(table) {
  const q = { table, ops: [] };
  calls.push(q);
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(respond(q)).then(res, rej);
      if (prop === 'maybeSingle' || prop === 'single') return async () => respond(q);
      return (...args) => { q.ops.push([prop, ...args]); return b; };
    },
  });
  return b;
}

mock.module('./supabase.js', { namedExports: { supabase: { from: chain } } });
mock.module('./enrichment.js', { namedExports: { classifyEvent: async () => ({ fromCache: true }) } });

const { upsertEvent, upsertEvents, reconcileCanonical, eventSlug, startCrawlRun } = await import('./base-crawler.js');

const op = (q, name) => q.ops.find(o => o[0] === name);
const upsertCall = () => calls.find(q => op(q, 'upsert'));

const baseEvent = {
  id: '0123456789abcdef',
  title: 'Jazz @ the Park!',
  startDate: '2026-09-28T01:00:00.000Z', // 9pm Sunday 27th, NYC
  time: null,
  location: { name: 'Central Park' },
  categories: ['Jazz'],
};

beforeEach(() => { calls.length = 0; respond = () => ({ data: null, error: null }); });

describe('eventSlug', () => {
  it('matches the 0021_public_slugs SQL backfill', () => {
    // lower(regexp_replace(title, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || left(id, 8)
    assert.equal(eventSlug('Jazz @ the Park!', '0123456789abcdef'), 'jazz-the-park--01234567');
    assert.equal(eventSlug('Café Night', 'abcdef0123456789'), 'caf-night-abcdef01');
  });
});

describe('upsertEvent', () => {
  it('writes NYC start_date, start_at and time', async () => {
    await upsertEvent({ ...baseEvent });
    const row = op(upsertCall(), 'upsert')[1];
    assert.equal(row.start_date, '2026-09-27');
    assert.equal(row.start_at, '2026-09-28T01:00:00.000Z');
    assert.equal(row.time, '9:00 PM');
  });

  it('sets slug + published on new events', async () => {
    const res = await upsertEvent({ ...baseEvent });
    const row = op(upsertCall(), 'upsert')[1];
    assert.equal(row.slug, 'jazz-the-park--01234567');
    assert.equal(row.published, true);
    assert.equal(res.status, 'new');
  });

  it('does not touch slug or published when the row already has a slug', async () => {
    respond = (q) => (op(q, 'select')?.[1] === 'id, slug'
      ? { data: { id: baseEvent.id, slug: 'old-slug-01234567' }, error: null }
      : { data: null, error: null });
    const res = await upsertEvent({ ...baseEvent, title: 'Renamed' });
    const row = op(upsertCall(), 'upsert')[1];
    assert.equal('slug' in row, false);
    assert.equal('published' in row, false);
    assert.equal(res.status, 'updated');
  });

  it('leaves image columns out of the row when the crawl found no image', async () => {
    await upsertEvent({ ...baseEvent, images: [] });
    const row = op(upsertCall(), 'upsert')[1];
    assert.equal('image' in row, false);
    assert.equal('images' in row, false);
  });

  it('writes image columns when the crawl found an image', async () => {
    await upsertEvent({ ...baseEvent, images: ['https://example.com/a.jpg'] });
    const row = op(upsertCall(), 'upsert')[1];
    assert.equal(row.image, 'https://example.com/a.jpg');
    assert.deepEqual(row.images, ['https://example.com/a.jpg']);
  });
});

describe('reconcileCanonical', () => {
  const reconcileSelect = (q) => q.table === 'events' && op(q, 'in')?.[1] === 'start_date';

  const rowDice = {
    id: 'x1', source: 'DICE', title: 'Warehouse Rave', description: '', images: [],
    categories: [], tags: [], start_date: '2026-11-01', time: '10:00 PM',
    venue: { name: 'BK Warehouse' }, location: { lat: 40.72, lng: -73.94 },
    price_min: null, price_max: null, ticket_url: 'https://dice.fm/e/x', source_url: null,
  };
  const rowRa = {
    ...rowDice, id: 'x2', source: 'Resident Advisor', description: 'Big room, live set.',
    images: ['https://ra.co/f.jpg'], ticket_url: 'https://ra.co/e/x',
    categories: ['Nightlife', 'Music'],
  };

  it('links cross-source rows: richest stays visible, losers get hidden_reason=duplicate', async () => {
    respond = (q) => (reconcileSelect(q) ? { data: [rowDice, rowRa], error: null } : { data: null, error: null });
    const res = await reconcileCanonical([
      { id: 'x1', source: 'DICE', title: 'Warehouse Rave', startDate: '2026-11-01T22:00:00-05:00', location: { name: 'BK Warehouse' } },
      { id: 'x2', source: 'Resident Advisor', title: 'Warehouse Rave', startDate: '2026-11-01T22:00:00-05:00', location: { name: 'BK Warehouse' } },
    ]);
    assert.equal(res.groups, 1);

    const winner = calls.find((q) => op(q, 'update')?.[1]?.canonical_event_id === 'x2' && op(q, 'update')[1].hidden_reason === null);
    assert.equal(op(winner, 'eq')[1], 'id');
    assert.equal(op(winner, 'eq')[2], 'x2');
    assert.deepEqual(
      [...op(winner, 'update')[1].dup_sources].sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: 'x1', source: 'DICE' },
        { id: 'x2', source: 'Resident Advisor' },
      ],
    );
    assert.equal(op(winner, 'update')[1].ticket_url, 'https://ra.co/e/x'); // winner's ticket kept
    assert.equal(op(winner, 'update')[1].image, 'https://ra.co/f.jpg');

    const hide = calls.find((q) => op(q, 'update')?.[1]?.hidden_reason === 'duplicate');
    assert.deepEqual(op(hide, 'in'), ['in', 'id', ['x1']]);
  });

  it('does not merge rows from the same source', async () => {
    respond = (q) => (reconcileSelect(q) ? { data: [{ ...rowDice }, { ...rowDice, id: 'x3' }], error: null } : { data: null, error: null });
    const res = await reconcileCanonical([
      { id: 'x1', source: 'DICE', title: 'Warehouse Rave', startDate: '2026-11-01T22:00:00-05:00', location: { name: 'BK Warehouse' } },
      { id: 'x3', source: 'DICE', title: 'Warehouse Rave', startDate: '2026-11-01T22:00:00-05:00', location: { name: 'BK Warehouse' } },
    ]);
    assert.equal(res.groups, 0);
    assert.equal(calls.some((q) => op(q, 'update')?.[1]?.hidden_reason === 'duplicate'), false);
  });

  it('is run by upsertEvents', async () => {
    respond = (q) => (reconcileSelect(q) ? { data: [rowDice, rowRa], error: null } : { data: null, error: null });
    await upsertEvents([
      { id: 'x1', source: 'DICE', title: 'Warehouse Rave', startDate: '2026-11-01T22:00:00-05:00', time: '10:00 PM', location: { name: 'BK Warehouse' } },
      { id: 'x2', source: 'Resident Advisor', title: 'Warehouse Rave', startDate: '2026-11-01T22:00:00-05:00', time: '10:00 PM', location: { name: 'BK Warehouse' } },
    ]);
    const hide = calls.find((q) => op(q, 'update')?.[1]?.hidden_reason === 'duplicate');
    assert.ok(hide, 'expected reconcile to hide the losing duplicate');
    assert.deepEqual(op(hide, 'in'), ['in', 'id', ['x1']]);
  });
});

describe('startCrawlRun budget', () => {
  it('sums today\'s spend by crawl_runs.started_at', async () => {
    respond = (q) => {
      if (q.table === 'crawl_runs' && op(q, 'gte')) return { data: [{ llm_cost_usd: '0.10' }, { llm_cost_usd: 0.07 }], error: null };
      if (q.table === 'crawl_runs' && op(q, 'insert')) return { data: { id: 'run-1' }, error: null };
      return { data: { llm_daily_budget_usd: 0.15 }, error: null };
    };
    const { _runState } = await import('./base-crawler.js');
    assert.equal(await startCrawlRun('ical-feeds'), 'run-1');
    const spendQ = calls.find(q => q.table === 'crawl_runs' && op(q, 'gte'));
    assert.equal(op(spendQ, 'gte')[1], 'started_at');
    assert.ok(Math.abs(_runState.todaySpend - 0.17) < 1e-9);
    assert.equal(_runState.llmBudgetExceeded, true);
  });
});

describe('upsertEvent dedup + non-event filter', () => {
  const dupQuery = (q) => q.table === 'events' && op(q, 'eq')?.[1] === 'fingerprint';

  it('skips the incoming event when a visible duplicate is at least as rich', async () => {
    respond = (q) => dupQuery(q)
      ? { data: [{ id: 'aaa', description: 'x'.repeat(500), images: [], categories: [] }], error: null }
      : { data: null, error: null };
    const res = await upsertEvent({ ...baseEvent, description: 'short' });
    assert.equal(res.status, 'duplicate');
    assert.equal(upsertCall(), undefined);
    const dq = calls.find(dupQuery);
    assert.deepEqual(op(dq, 'is'), ['is', 'hidden_reason', null]);
  });

  it('upserts a richer incoming event and hides every row it replaces', async () => {
    respond = (q) => dupQuery(q)
      ? { data: [{ id: 'aaa', description: 'a' }, { id: 'bbb', description: 'b' }], error: null }
      : { data: null, error: null };
    await upsertEvent({ ...baseEvent, description: 'a much longer description' });
    assert.equal(op(upsertCall(), 'upsert')[1].hidden_reason, null);
    const hide = calls.find(q => op(q, 'update')?.[1]?.hidden_reason === 'duplicate');
    assert.deepEqual(op(hide, 'in'), ['in', 'id', ['aaa', 'bbb']]);
  });

  it('stores non-events hidden and leaves hidden_reason untouched otherwise', async () => {
    await upsertEvent({ ...baseEvent, title: 'High School Football Games Coverage Poll' });
    assert.equal(op(upsertCall(), 'upsert')[1].hidden_reason, 'non_event:poll');

    calls.length = 0;
    await upsertEvent({ ...baseEvent });
    assert.equal('hidden_reason' in op(upsertCall(), 'upsert')[1], false);
  });
});
