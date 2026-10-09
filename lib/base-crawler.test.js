import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chainable fake of the supabase client. Every call is recorded; awaiting a
// chain (or .maybeSingle()/.single()) resolves to the response picked by `respond`.
const calls = [];
let respond = () => ({ data: null, error: null });
let classifyImpl = async () => ({ fromCache: true });

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
mock.module('./enrichment.js', { namedExports: { classifyEvent: (event) => classifyImpl(event) } });

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  calls.length = 0;
  respond = () => ({ data: null, error: null });
  classifyImpl = async () => ({ fromCache: true });
  delete process.env.UPSERT_CONCURRENCY;
});

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
  // Reconcile now filters `start_date` with a lexicographic range (`gte`/`lt`), not an
  // exact `.in()`. `start_date` is TEXT and most rows carry a time suffix, so an exact
  // match found nothing — see the regression test below.
  const reconcileSelect = (q) => q.table === 'events' && op(q, 'gte')?.[1] === 'start_date';

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

  it('scopes the query with a text range, not an exact date match (regression: linked zero rows)', async () => {
    // `events.start_date` is TEXT and most rows store 'YYYY-MM-DDThh:mm:ss.sssZ', so an
    // exact `.in('start_date', ['2026-11-01'])` matched only the time-less rows — usually
    // none — and reconcile silently linked zero rows on every run. The query must span
    // [day, nextDay) so both '2026-11-01' and '2026-11-01T...' are included.
    respond = () => ({ data: [], error: null });
    await reconcileCanonical([
      { id: 'x1', source: 'DICE', title: 'Warehouse Rave', startDate: '2026-11-01T22:00:00-05:00', location: { name: 'BK Warehouse' } },
    ]);
    const selectQ = calls.find((q) => q.table === 'events' && op(q, 'gte'));
    assert.ok(selectQ, 'expected a range-filtered select');
    assert.deepEqual(op(selectQ, 'gte'), ['gte', 'start_date', '2026-11-01']);
    assert.deepEqual(op(selectQ, 'lt'), ['lt', 'start_date', '2026-11-02']);
    assert.equal(
      calls.some((q) => op(q, 'in')?.[1] === 'start_date'),
      false,
      'must not use an exact .in(start_date) match',
    );
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

describe('aborted runs', () => {
  it('stamps a terminal error state on an in-flight run', async () => {
    respond = (q) => {
      if (q.table === 'crawl_runs' && op(q, 'insert')) return { data: { id: 'run-9' }, error: null };
      return { data: null, error: null };
    };
    const { abortActiveCrawlRuns } = await import('./base-crawler.js');
    assert.equal(await startCrawlRun('ticketmaster'), 'run-9');
    calls.length = 0;

    await abortActiveCrawlRuns('aborted: SIGTERM');

    const upd = calls.find((q) => q.table === 'crawl_runs' && op(q, 'update') && op(q, 'eq')?.[2] === 'run-9');
    assert.ok(upd, 'expected an update for run-9');
    const fields = op(upd, 'update')[1];
    assert.equal(fields.status, 'error');
    assert.ok(fields.finished_at, 'expected finished_at to be set');
    assert.deepEqual(fields.error_messages, ['aborted: SIGTERM']);
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

// ── upsertEvents concurrency (bounded worker pool) ──────────────────────────
// Ticketmaster wrote only 3,424 of 11,325 events before the 60m CI cap because
// the batch upsert was strictly sequential (~1 event/sec). These tests pin the
// parallel scheduling: bounded in-flight count, deterministic same-fingerprint
// dedup, correct counters, and an unblown LLM budget.
describe('upsertEvents concurrency', () => {
  const matchCat = ['Jazz']; // deterministic category → no LLM path
  const mkEvents = (n) => Array.from({ length: n }, (_, i) => ({
    ...baseEvent,
    id: String(i).padStart(16, '0'),
    title: `Event ${i}`,
    description: `desc ${i}`,
    categories: matchCat,
  }));

  it('returns the correct counters while running events in flight', async () => {
    let inFlight = 0, maxInFlight = 0;
    const existing = new Set(['0000000000000003', '0000000000000004']);
    const ERR_ID = '0000000000000006';
    const events = mkEvents(7);
    respond = async (q) => {
      if (q.table === 'events' && op(q, 'upsert')) {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(2);
        inFlight--;
        const row = op(q, 'upsert')[1];
        return row.id === ERR_ID ? { data: null, error: { message: 'boom' } } : { data: null, error: null };
      }
      if (q.table === 'events' && op(q, 'select')?.[1] === 'id, slug') {
        const id = op(q, 'eq')[2];
        return { data: existing.has(id) ? { id, slug: 'a-slug' } : null, error: null };
      }
      if (q.table === 'events' && op(q, 'eq')?.[1] === 'fingerprint') {
        return { data: [], error: null }; // no cross-batch dups
      }
      return { data: null, error: null };
    };

    const res = await upsertEvents(events);
    assert.equal(res.new, 4);          // 7 - 2 existing - 1 error
    assert.equal(res.updated, 2);
    assert.equal(res.deduped, 0);
    assert.equal(res.errors.length, 1);
    assert.equal(res.uncategorized, 0);
    assert.ok(maxInFlight > 1, `expected events in flight, saw ${maxInFlight}`);
  });

  it('bounds in-flight upserts by UPSERT_CONCURRENCY', async () => {
    process.env.UPSERT_CONCURRENCY = '4';
    let inFlight = 0, maxInFlight = 0;
    respond = async (q) => {
      if (q.table === 'events' && op(q, 'upsert')) {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(3);
        inFlight--;
        return { data: null, error: null };
      }
      if (q.table === 'events' && op(q, 'eq')?.[1] === 'fingerprint') return { data: [], error: null };
      return { data: null, error: null };
    };
    const res = await upsertEvents(mkEvents(24));
    assert.equal(res.new, 24);
    assert.ok(maxInFlight <= 4, `cap 4 exceeded: saw ${maxInFlight}`);
    assert.ok(maxInFlight >= 2, `pool did not parallelise: saw ${maxInFlight}`);
  });

  it('serialises same-fingerprint events so the dedup never double-inserts', async () => {
    process.env.UPSERT_CONCURRENCY = '8';
    const store = new Map(); // id -> stored row (models the events table)
    const a = { ...baseEvent, id: 'aaaaaaaaaaaaaaaa', title: 'Twin Show', description: 'x'.repeat(200), categories: matchCat };
    const b = { ...baseEvent, id: 'bbbbbbbbbbbbbbbb', title: 'Twin Show', description: 'x'.repeat(200), categories: matchCat };
    respond = async (q) => {
      if (q.table === 'events' && op(q, 'upsert')) {
        await sleep(4);
        const row = op(q, 'upsert')[1];
        store.set(row.id, {
          id: row.id, description: row.description,
          images: row.images ?? [], categories: row.categories ?? [],
          fingerprint: row.fingerprint,
        });
        return { data: null, error: null };
      }
      if (q.table === 'events' && op(q, 'eq')?.[1] === 'fingerprint') {
        const fp = op(q, 'eq')[2];
        const exclude = op(q, 'neq')?.[2];
        await sleep(4); // widen the race window so a naive fan-out double-inserts
        return { data: [...store.values()].filter((r) => r.fingerprint === fp && r.id !== exclude), error: null };
      }
      return { data: null, error: null };
    };

    const res = await upsertEvents([a, b]);
    const inserts = calls.filter((q) => q.table === 'events' && op(q, 'upsert')).length;
    assert.equal(inserts, 1, 'two same-fingerprint events must produce exactly one insert');
    assert.equal(res.new + res.updated, 1);
    assert.equal(res.deduped, 1);
  });

  it('does not exceed the daily LLM budget under concurrency', async () => {
    const { _runState } = await import('./base-crawler.js');
    _runState.todaySpend = 0; _runState.llmCostUsd = 0; _runState.llmCalls = 0;
    _runState.dailyBudget = 0.30; _runState.llmBudgetExceeded = false;
    classifyImpl = async () => {
      await sleep(3);
      return { canonical_categories: ['music'], fromCache: false, cost: 0.10 };
    };
    process.env.UPSERT_CONCURRENCY = '10';
    respond = async (q) => {
      if (q.table === 'events' && op(q, 'upsert')) { await sleep(1); return { data: null, error: null }; }
      return { data: null, error: null };
    };
    const events = Array.from({ length: 20 }, (_, i) => ({
      ...baseEvent, id: String(i).padStart(16, '0'),
      title: `Unmatched ${i}`, description: 'd', categories: ['Blorp'],
    }));

    await upsertEvents(events);
    // 0.30 budget / 0.10 per call = 3 calls, exactly as a sequential run would do.
    assert.equal(_runState.llmCalls, 3, `budget blown: ${_runState.llmCalls} LLM calls`);
    assert.ok(_runState.llmCostUsd <= 0.31, `cost ${_runState.llmCostUsd} exceeded budget`);
  });
});
