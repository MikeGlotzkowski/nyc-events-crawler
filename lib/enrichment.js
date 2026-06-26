import crypto from 'crypto';
import { supabase } from './supabase.js';
import { chatJSON } from './openrouter.js';

export const VIBE_VOCAB = [
  'chill', 'high-energy', 'artsy', 'romantic', 'family',
  'late-night', 'outdoorsy', 'underground', 'bougie', 'wholesome',
];

// google/gemini-2.5-flash pricing on OpenRouter (USD per token)
const PRICE_INPUT = 0.15 / 1_000_000;
const PRICE_OUTPUT = 0.60 / 1_000_000;

const TAXONOMY_BUCKETS = [
  'music', 'food', 'arts', 'nightlife', 'comedy', 'theater',
  'wellness', 'sports', 'film', 'family', 'tours', 'markets', 'community',
];

export function contentHash(event) {
  const text = (event.title ?? '') + '|' + (event.description ?? '').slice(0, 300);
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * Classify an event using cache-first LLM lookup.
 * @returns {{ canonical_categories, is_family, vibe_tags, short_description, fromCache, cost }}
 */
export async function classifyEvent(event) {
  const hash = contentHash(event);

  // Cache hit
  const { data: cached } = await supabase
    .from('llm_cache')
    .select('canonical_categories, is_family, vibe_tags, short_description')
    .eq('content_hash', hash)
    .maybeSingle();

  if (cached) {
    return { ...cached, fromCache: true, cost: 0 };
  }

  // Cache miss — one structured call
  const context = [
    event.title,
    (event.categories ?? []).join(', '),
    (event.description ?? '').substring(0, 500),
  ].filter(Boolean).join(' | ');

  const { json, usage } = await chatJSON([{
    role: 'user',
    content:
      `Classify this NYC event. Return JSON with exactly these fields:\n` +
      `- canonical_categories: array of 1-3 from: ${TAXONOMY_BUCKETS.join(', ')}\n` +
      `- is_family: boolean (true if designed/appropriate for children)\n` +
      `- vibe_tags: array of 1-3 from: ${VIBE_VOCAB.join(', ')}\n` +
      `- short_description: one sentence ≤150 chars\n\n` +
      `Event: ${context}`,
  }], { maxTokens: 200 });

  const result = {
    canonical_categories: Array.isArray(json.canonical_categories)
      ? json.canonical_categories.filter(c => TAXONOMY_BUCKETS.includes(c))
      : [],
    is_family: Boolean(json.is_family),
    vibe_tags: Array.isArray(json.vibe_tags)
      ? json.vibe_tags.filter(t => VIBE_VOCAB.includes(t))
      : [],
    short_description: typeof json.short_description === 'string'
      ? json.short_description.slice(0, 150)
      : null,
  };

  await supabase.from('llm_cache').insert({
    content_hash: hash,
    ...result,
    model: 'google/gemini-2.5-flash',
  });

  const cost =
    (usage.prompt_tokens ?? 0) * PRICE_INPUT +
    (usage.completion_tokens ?? 0) * PRICE_OUTPUT;

  return { ...result, fromCache: false, cost };
}
