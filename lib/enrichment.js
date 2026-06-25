import OpenAI from 'openai';
import { loadEnv } from '../env-loader.js';

loadEnv();

export const VIBE_VOCAB = [
  'chill', 'high-energy', 'artsy', 'romantic', 'family',
  'late-night', 'outdoorsy', 'underground', 'bougie', 'wholesome',
];

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function hasVibeTags(tags) {
  if (!Array.isArray(tags)) return false;
  const vocabSet = new Set(VIBE_VOCAB);
  return tags.some(t => vocabSet.has(String(t).toLowerCase()));
}

/**
 * Append 1–3 vibe tags from VIBE_VOCAB to event.tags using gpt-4o-mini.
 * Returns the event unchanged on any error. Skips if vibe tags already present.
 */
export async function enrichWithVibeTags(event) {
  if (hasVibeTags(event.tags)) return event;
  if (!openai) return event;

  try {
    const context = [
      event.title,
      (event.categories ?? []).join(', '),
      (event.description ?? '').substring(0, 300),
    ].filter(Boolean).join(' | ');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content:
          `Pick 1–3 vibe tags for this NYC event from this exact list only: ${VIBE_VOCAB.join(', ')}.\n` +
          `Event: ${context}\n` +
          `Return JSON: { "tags": ["tag1"] }`,
      }],
      temperature: 0,
      response_format: { type: 'json_object' },
      max_tokens: 60,
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    const vocabSet = new Set(VIBE_VOCAB);
    const vibeTags = (Array.isArray(parsed.tags) ? parsed.tags : [])
      .map(t => String(t).toLowerCase())
      .filter(t => vocabSet.has(t));

    if (vibeTags.length > 0) {
      const existing = new Set((event.tags ?? []).map(t => String(t).toLowerCase()));
      event.tags = [
        ...(event.tags ?? []),
        ...vibeTags.filter(t => !existing.has(t)),
      ];
    }
  } catch {
    // Never block a crawl — return event as-is
  }

  return event;
}
