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

const { upsertEvent, eventSlug, startCrawlRun } = await import('./base-crawler.js');

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
