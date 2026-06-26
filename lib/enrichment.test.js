import { describe, it, mock, before } from 'node:test';
import assert from 'node:assert/strict';

// In-memory cache to simulate supabase llm_cache table
const cacheStore = new Map();
let chatJSONCalls = 0;

mock.module('./supabase.js', {
  namedExports: {
    supabase: {
      from: (table) => ({
        select: (_cols) => ({
          eq: (_col, val) => ({
            maybeSingle: async () => ({ data: cacheStore.get(val) ?? null, error: null }),
          }),
        }),
        insert: async (data) => {
          cacheStore.set(data.content_hash, data);
          return { error: null };
        },
      }),
    },
  },
});

mock.module('./openrouter.js', {
  namedExports: {
    chatJSON: async (_messages, _opts) => {
      chatJSONCalls++;
      return {
        json: {
          canonical_categories: ['music'],
          is_family: false,
          vibe_tags: ['chill'],
          short_description: 'A live music event in NYC.',
        },
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      };
    },
  },
});

const { classifyEvent, contentHash } = await import('./enrichment.js');

describe('classifyEvent', () => {
  const event = {
    title: 'Jazz Night at Blue Note',
    description: 'An evening of smooth jazz featuring local musicians.',
    categories: ['unknown-genre'],
  };

  before(() => {
    cacheStore.clear();
    chatJSONCalls = 0;
  });

  it('returns LLM result with fromCache=false on first call', async () => {
    const result = await classifyEvent(event);
    assert.equal(result.fromCache, false);
    assert.deepEqual(result.canonical_categories, ['music']);
    assert.equal(result.is_family, false);
    assert.deepEqual(result.vibe_tags, ['chill']);
    assert.equal(result.short_description, 'A live music event in NYC.');
    assert.ok(result.cost > 0, 'cost should be positive');
    assert.equal(chatJSONCalls, 1);
  });

  it('returns cached result with fromCache=true on second call (0 chatJSON calls)', async () => {
    const before = chatJSONCalls;
    const result = await classifyEvent(event);
    assert.equal(result.fromCache, true);
    assert.equal(result.cost, 0);
    assert.deepEqual(result.canonical_categories, ['music']);
    assert.equal(chatJSONCalls, before, 'no additional chatJSON calls on cache hit');
  });

  it('contentHash is stable for same title+desc', () => {
    const h1 = contentHash(event);
    const h2 = contentHash(event);
    assert.equal(h1, h2);
  });

  it('different events produce different hashes', () => {
    const other = { title: 'Yoga in the Park', description: 'Outdoor yoga session.' };
    assert.notEqual(contentHash(event), contentHash(other));
  });
});
