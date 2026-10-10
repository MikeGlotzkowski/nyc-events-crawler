/**
 * Daily topic-page generator — fixture-driven. No live network, no live Supabase.
 * The Supabase client and the OpenRouter helper are injected, so every test runs
 * against an in-memory fake.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// base-crawler (imported for log) pulls in lib/supabase.js, which throws unless
// these are set. The tests never construct a real client.
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = 'test-key';

const {
  TOPICS, topicSlugs, MIN_EVENTS, FEATURED_CATEGORIES,
  nycYmd, addDays, weekdayOf, resolveWindow,
  qualifies, selectEvents, inWindow, score,
  contentHash, templateCopy, generateCopy, planPages,
  fetchUpcomingEvents, runTopicPages, createSupabaseCopyCache,
} = await import('./topic-pages.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

let nextId = 0;
/** An events row in the shape fetchUpcomingEvents returns. */
function ev(over = {}) {
  return {
    id: `id${String(++nextId).padStart(4, '0')}`,
    slug: `slug-${nextId}`,
    title: 'Untitled Event',
    start_date: '2026-10-10',
    end_date: null,
    time: '7:00 PM',
    image: null,
    borough: 'Brooklyn',
    neighborhood: 'Williamsburg',
    canonical_category: 'music',
    canonical_categories: ['music'],
    is_free: false,
    price_min: 20,
    venue: { name: 'Venue' },
    quality_score: 50,
    hidden_reason: null,
    source: 'Test',
    ...over,
  };
}

/** Chainable fake Supabase query; only the calls fetchUpcomingEvents makes. */
function fakeSupabase(rows) {
  class Q {
    constructor(r) { this.rows = r; }
    select() { return this; }
    is(field, value) { this.rows = this.rows.filter(x => x[field] === value); return this; }
    gte(field, value) { this.rows = this.rows.filter(x => x[field] >= value); return this; }
    order() { return this; }
    limit() { return this; }
    then(res, rej) { return Promise.resolve({ data: this.rows, error: null }).then(res, rej); }
  }
  return { from: () => new Q(rows.slice()) };
}

/** In-memory repository recording the writes, so idempotency is observable. */
function memoryRepo({ chatJSON } = {}) {
  const lists = new Map();   // slug → row (+ id)
  const items = new Map();   // list_id → [{event_id, position}]
  let idSeq = 0;
  return {
    lists,
    items,
    async upsertList(row) {
      const id = lists.get(row.slug)?.id ?? `list-${++idSeq}`;
      lists.set(row.slug, { ...row, id });
      return { id };
    },
    async replaceItems(listId, positions) {
      items.set(listId, positions.map(([event_id, position]) => ({ list_id: listId, event_id, position })));
    },
    async generateCopy(topic, events, deps = {}) {
      return generateCopy(topic, events, deps);
    },
    _deps: { chatJSON, cache: new Map() },
  };
}

const llmReply = (description, intro) => async () => ({
  json: { description, intro },
  usage: { prompt_tokens: 100, completion_tokens: 40 },
});

beforeEach(() => { nextId = 0; });

// ── Topic list ───────────────────────────────────────────────────────────────

describe('topic list', () => {
  it('builds ~50 deterministic, unique slugs', () => {
    const slugs = topicSlugs();
    assert.ok(slugs.length >= 45 && slugs.length <= 60, `expected ~50, got ${slugs.length}`);
    assert.equal(new Set(slugs).size, slugs.length, 'slugs must be unique');
    assert.deepEqual(slugs, topicSlugs()); // stable across calls
    assert.deepEqual(slugs, topicSlugs());
  });

  it('covers the five time-intent topics', () => {
    for (const s of ['tonight', 'this-weekend', 'this-week', 'free-this-weekend', 'free-tonight']) {
      assert.ok(topicSlugs().includes(s), `missing ${s}`);
    }
  });

  it('covers geo × category and free-by-borough', () => {
    assert.ok(topicSlugs().includes('live-music-in-brooklyn'));
    assert.ok(topicSlugs().includes('comedy-in-manhattan'));
    assert.ok(topicSlugs().includes('free-events-in-queens'));
    for (const [word] of [['live-music'], ['comedy'], ['film'], ['art'], ['theater'], ['food']]) {
      assert.ok(topicSlugs().includes(`${word}-in-brooklyn`), `missing ${word}-in-brooklyn`);
    }
  });

  it('has one hub per taxonomy bucket', () => {
    for (const key of ['music', 'comedy', 'film', 'arts', 'nightlife', 'food', 'theater', 'wellness', 'sports', 'family', 'tours', 'markets', 'community']) {
      assert.ok(topicSlugs().includes(key), `missing hub ${key}`);
    }
  });

  it('featured categories are all real buckets', () => {
    assert.equal(FEATURED_CATEGORIES.length, 6);
  });
});

// ── Windows (pure) ───────────────────────────────────────────────────────────

describe('resolveWindow', () => {
  it('tonight is the current NYC day', () => {
    assert.deepEqual(resolveWindow('tonight', '2026-10-09'), { from: '2026-10-09', to: '2026-10-09' });
    assert.deepEqual(resolveWindow('free-tonight', '2026-10-09'), { from: '2026-10-09', to: '2026-10-09' });
  });

  it('this-weekend runs to the coming Sunday', () => {
    // 2026-10-09 is a Friday → Sunday is the 11th
    assert.equal(weekdayOf('2026-10-09'), 5);
    assert.deepEqual(resolveWindow('this-weekend', '2026-10-09'), { from: '2026-10-09', to: '2026-10-11' });
    // 2026-10-11 is itself a Sunday → same day
    assert.equal(weekdayOf('2026-10-11'), 0);
    assert.deepEqual(resolveWindow('this-weekend', '2026-10-11'), { from: '2026-10-11', to: '2026-10-11' });
  });

  it('this-week is the next seven days', () => {
    assert.deepEqual(resolveWindow('this-week', '2026-10-09'), { from: '2026-10-09', to: '2026-10-15' });
  });

  it('nycYmd/addDays helpers are consistent', () => {
    assert.equal(addDays('2026-10-09', 6), '2026-10-15');
    assert.match(nycYmd(new Date('2026-10-09T12:00:00Z')), /^2026-10-\d\d$/);
  });
});

// ── Selection ────────────────────────────────────────────────────────────────

describe('selection', () => {
  const today = '2026-10-09';
  const music = TOPICS.find(t => t.slug === 'music');

  it('excludes hidden and past events', () => {
    const hidden = ev({ hidden_reason: 'duplicate' });
    const past = ev({ start_date: '2026-10-01' });
    const future = ev({ start_date: '2026-10-12' });
    assert.equal(qualifies(hidden, music, today), false);
    assert.equal(qualifies(past, music, today), false);
    assert.equal(qualifies(future, music, today), true);
  });

  it('keeps an ongoing event whose window still covers today', () => {
    const ongoing = ev({ start_date: '2026-10-05', end_date: '2026-10-20' });
    assert.equal(inWindow(ongoing, { from: today, to: addDays(today, 30) }), true);
    assert.equal(inWindow(ev({ start_date: '2026-10-01' }), { from: today, to: addDays(today, 30) }), false);
  });

  it('filters by category and borough, and by free', () => {
    const comedyInBk = TOPICS.find(t => t.slug === 'comedy-in-brooklyn');
    assert.equal(qualifies(ev({ canonical_category: 'comedy', borough: 'Brooklyn' }), comedyInBk, today), true);
    assert.equal(qualifies(ev({ canonical_category: 'music', borough: 'Brooklyn' }), comedyInBk, today), false);
    assert.equal(qualifies(ev({ canonical_category: 'comedy', borough: 'Queens' }), comedyInBk, today), false);
    const freeTonight = TOPICS.find(t => t.slug === 'free-tonight');
    assert.equal(qualifies(ev({ is_free: true, start_date: today }), freeTonight, today), true);
    assert.equal(qualifies(ev({ is_free: false, price_min: 10, start_date: today }), freeTonight, today), false);
  });

  it('orders deterministically: score, then start_date, then id', () => {
    const low = ev({ id: 'aaa', quality_score: 10, start_date: '2026-10-12' });
    const high = ev({ id: 'bbb', quality_score: 90, start_date: '2026-10-15' });
    const tieEarly = ev({ id: 'ccc', quality_score: 50, start_date: '2026-10-10' });
    const tieLate = ev({ id: 'ddd', quality_score: 50, start_date: '2026-10-11' });
    const picked = selectEvents([low, high, tieEarly, tieLate], music, today, 4);
    assert.deepEqual(picked.map(e => e.id), ['bbb', 'ccc', 'ddd', 'aaa']);
    // same input in a different order → same output
    const again = selectEvents([tieLate, high, low, tieEarly], music, today, 4);
    assert.deepEqual(again.map(e => e.id), picked.map(e => e.id));
  });

  it('caps the selection at n', () => {
    const many = Array.from({ length: 30 }, (_, i) => ev({ start_date: '2026-10-12', id: `id-${i}` }));
    assert.equal(selectEvents(many, music, today, 12).length, 12);
  });
});

// ── Plan / index discipline ──────────────────────────────────────────────────

describe('planPages', () => {
  const today = '2026-10-09';
  const music = TOPICS.find(t => t.slug === 'music');

  it('publishes a topic at or above the minimum', () => {
    const events = Array.from({ length: MIN_EVENTS }, (_, i) => ev({ start_date: '2026-10-12', id: `m${i}` }));
    const [page] = planPages([music], events, today);
    assert.equal(page.published, true);
    assert.equal(page.items.length, MIN_EVENTS);
    assert.equal(page.items.length, MIN_EVENTS);
    assert.match(page.reason, /published/);
  });

  it('marks a below-minimum topic published=false rather than deleting it', () => {
    const events = Array.from({ length: MIN_EVENTS - 1 }, (_, i) => ev({ start_date: '2026-10-12', id: `m${i}` }));
    const [page] = planPages([music], events, today);
    assert.equal(page.published, false);
    assert.deepEqual(page.items, []);
    assert.match(page.reason, /below min/);
    // The topic still exists in the plan (URL preserved, written with published=false).
    assert.equal(page.slug, 'music');
  });

  it('picks a cover image when one is available', () => {
    const withImg = ev({ start_date: '2026-10-12', image: 'https://cdn/x.jpg' });
    const rest = Array.from({ length: MIN_EVENTS - 1 }, (_, i) => ev({ start_date: '2026-10-12', id: `m${i}` }));
    const [page] = planPages([music], [withImg, ...rest], today);
    assert.equal(page.cover_image_url, 'https://cdn/x.jpg');
  });
});

// ── Copy + fallback ──────────────────────────────────────────────────────────

describe('generateCopy', () => {
  const today = '2026-10-09';
  const music = TOPICS.find(t => t.slug === 'music');
  const events = Array.from({ length: 8 }, (_, i) => ev({ start_date: '2026-10-12', id: `m${i}`, title: `Show ${i}` }));

  it('uses the LLM copy when it succeeds', async () => {
    const res = await generateCopy(music, events, { chatJSON: llmReply('Eight shows around town.', 'A short list of shows this month. Most are in Brooklyn.') });
    assert.equal(res.source, 'llm');
    assert.equal(res.description, 'Eight shows around town.');
    assert.ok(res.intro.length > 10);
    assert.ok(res.cost > 0);
  });

  it('falls back to a deterministic template when the model is unavailable', async () => {
    const res = await generateCopy(music, events, { chatJSON: async () => { throw new Error('OPENROUTER_API_KEY not set'); } });
    assert.equal(res.source, 'template');
    assert.equal(res.cost, 0);
    assert.ok(res.description.length > 0);
    assert.ok(res.intro.includes('events'));
  });

  it('falls back when no chatJSON is provided at all', async () => {
    const res = await generateCopy(music, events, {});
    assert.equal(res.source, 'template');
    assert.ok(res.description.length > 0);
  });

  it('falls back when the model returns junk', async () => {
    const res = await generateCopy(music, events, { chatJSON: async () => ({ json: {}, usage: {} }) });
    assert.equal(res.source, 'template');
  });

  it('caches by content hash: an unchanged page never re-spends', async () => {
    let calls = 0;
    const chatJSON = async () => { calls++; return { json: { description: 'd', intro: 'i' }, usage: { prompt_tokens: 1, completion_tokens: 1 } }; };
    const cache = new Map();
    const a = await generateCopy(music, events, { chatJSON, cache });
    const b = await generateCopy(music, events, { chatJSON, cache });
    assert.equal(calls, 1);
    assert.equal(a.source, 'llm');
    assert.equal(b.cached, true);
    // different events → different hash → one more call
    await generateCopy(music, events.slice(0, 7), { chatJSON, cache });
    assert.equal(calls, 2);
  });

  it('contentHash is stable and order-sensitive', () => {
    assert.equal(contentHash(music, events), contentHash(music, events));
    assert.notEqual(contentHash(music, events), contentHash(music, events.slice().reverse()));
  });

  it('createSupabaseCopyCache reads and writes by content hash', async () => {
    const store = new Map();
    const supabase = {
      from(table) {
        assert.equal(table, 'list_copy_cache');
        const q = {
          v: undefined,
          select() { return q; },
          eq(_f, value) { q.v = value; return q; },
          maybeSingle: async () => ({ data: store.get(q.v) ?? null, error: null }),
          upsert: async (row) => { store.set(row.content_hash, row); return { error: null }; },
        };
        return q;
      },
    };
    const cache = createSupabaseCopyCache(supabase);
    const key = 'topic:abc';
    assert.equal(await cache.get(key), null);
    await cache.set(key, { description: 'd', intro: 'i' });
    assert.deepEqual(await cache.get(key), { description: 'd', intro: 'i' });
    // a second generateCopy with this cache makes no LLM call
    let calls = 0;
    const chatJSON = async () => { calls++; return { json: { description: 'd', intro: 'i' }, usage: {} }; };
    await generateCopy(music, events, { chatJSON, cache });
    const res = await generateCopy(music, events, { chatJSON, cache });
    assert.equal(calls, 1);
    assert.equal(res.cached, true);
  });

  it('template copy names where the events are', () => {
    const t = templateCopy(music, [ev({ borough: 'Brooklyn' }), ev({ borough: 'Brooklyn' }), ev({ borough: 'Queens' })]);
    assert.match(t.intro, /Brooklyn/);
    assert.match(t.description, /events/);
  });
});

// ── Runner: idempotency + index discipline ───────────────────────────────────

describe('runTopicPages', () => {
  it('writes every topic once and re-runs in place (no duplicates)', async () => {
    const events = [
      // enough for the music hub + music-in-Brooklyn, but nothing else
      ...Array.from({ length: 8 }, (_, i) => ev({ id: `m${i}`, slug: `m-${i}`, canonical_category: 'music', canonical_categories: ['music'], borough: 'Brooklyn', start_date: '2026-10-12' })),
    ];
    const repo = memoryRepo();
    const opts = { supabase: fakeSupabase(events), repo, now: new Date('2026-10-09T15:00:00Z') };

    const first = await runTopicPages(opts);
    assert.equal(repo.lists.size, TOPICS.length, 'one curated_lists row per topic');
    // music hub + live-music-in-brooklyn + this-week (same date window) clear the minimum
    assert.equal(first.published, 3, 'only the topics with >= 6 qualifying events publish');

    const itemsBefore = new Map([...repo.items].map(([k, v]) => [k, v.length]));
    const second = await runTopicPages(opts);

    assert.equal(repo.lists.size, TOPICS.length, 're-run does not add rows');
    assert.equal(second.published, first.published);
    // item sets are identical after a re-run — replace, not append
    for (const [listId, rows] of repo.items) {
      assert.equal(rows.length, itemsBefore.get(listId), `items for ${listId} changed size on re-run`);
    }
  });

  it('writes the required row shape and marks below-minimum topics unpublished with no items', async () => {
    const events = Array.from({ length: 8 }, (_, i) => ev({ id: `m${i}`, slug: `m-${i}`, canonical_category: 'music', canonical_categories: ['music'], borough: 'Brooklyn', start_date: '2026-10-12' }));
    const repo = memoryRepo();
    await runTopicPages({ supabase: fakeSupabase(events), repo, now: new Date('2026-10-09T15:00:00Z') });

    const pub = repo.lists.get('live-music-in-brooklyn');
    assert.equal(pub.city, 'nyc');
    assert.equal(pub.curator_name, 'NO MORE FOMO');
    assert.equal(pub.published, true);
    assert.ok(pub.description);
    const pubItems = repo.items.get(pub.id);
    assert.equal(pubItems.length, 8);
    assert.deepEqual(pubItems.map(r => r.position), [0, 1, 2, 3, 4, 5, 6, 7]);

    const skipped = repo.lists.get('comedy-in-manhattan');
    assert.equal(skipped.published, false);
    assert.deepEqual(repo.items.get(skipped.id), []);
  });

  it('uses template copy and still publishes when the LLM is unavailable', async () => {
    const events = Array.from({ length: 8 }, (_, i) => ev({ id: `m${i}`, slug: `m-${i}`, canonical_category: 'music', canonical_categories: ['music'], borough: 'Brooklyn', start_date: '2026-10-12' }));
    let calls = 0;
    const chatJSON = async () => { calls++; throw new Error('no key'); };
    const repo = memoryRepo({ chatJSON });
    const res = await runTopicPages({ supabase: fakeSupabase(events), repo, now: new Date('2026-10-09T15:00:00Z') });

    assert.equal(calls, 3); // one per published topic (music, live-music-in-brooklyn, this-week)
    assert.equal(res.llmCalls, 0);
    const pub = repo.lists.get('live-music-in-brooklyn');
    assert.equal(pub.published, true);
    assert.ok(pub.description, 'a template description still lets the page publish');
  });

  it('is idempotent across the item content, not just the count', async () => {
    const events = Array.from({ length: 8 }, (_, i) => ev({ id: `m${i}`, slug: `m-${i}`, canonical_category: 'music', canonical_categories: ['music'], borough: 'Brooklyn', start_date: '2026-10-12', quality_score: 50 + i }));
    const repo = memoryRepo();
    const opts = { supabase: fakeSupabase(events), repo, now: new Date('2026-10-09T15:00:00Z') };
    await runTopicPages(opts);
    const snapshot = JSON.stringify([...repo.items].sort());
    await runTopicPages(opts);
    assert.equal(JSON.stringify([...repo.items].sort()), snapshot);
  });
});

// ── fetchUpcomingEvents ──────────────────────────────────────────────────────

describe('fetchUpcomingEvents', () => {
  it('filters to visible upcoming rows and normalizes canonical_categories', async () => {
    const rows = [
      ev({ id: 'a', start_date: '2026-10-12', canonical_categories: ['music', 'arts'] }),
      ev({ id: 'b', start_date: '2026-10-01' }),                  // past
      ev({ id: 'c', start_date: '2026-10-12', hidden_reason: 'duplicate' }), // hidden
    ];
    const out = await fetchUpcomingEvents(fakeSupabase(rows), '2026-10-09');
    assert.deepEqual(out.map(e => e.id), ['a']);
    assert.deepEqual(out[0].canonical_categories, ['music', 'arts']);
  });
});
