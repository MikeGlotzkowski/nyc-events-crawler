import OpenAI from 'openai';
import { loadEnv } from '../env-loader.js';

loadEnv();

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function parseJSON(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ;
  const jsonStr = match ? match[1] : trimmed;
  return JSON.parse(jsonStr);
}

const CHUNK_CHARS = 6000;
const MAX_CHUNKS = 5;

/** Split long posts (The Skint weekend roundups) on paragraph boundaries. */
export function chunkContent(content, size = CHUNK_CHARS, max = MAX_CHUNKS) {
  const chunks = [];
  let rest = content;
  while (rest.length > size && chunks.length < max - 1) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = rest.lastIndexOf('. ', size) + 1;
    if (cut < size / 2) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest.slice(0, size));
  return chunks.filter(c => c.trim());
}

/**
 * Extract structured events from a blog post.
 * Returns an array of partial RealEvent objects (0, 1, or many).
 */
export async function extractEventsFromPost({ content, ...meta }) {
  if (!openai) throw new Error('OPENAI_API_KEY not set');

  const chunks = chunkContent(content ?? '');
  const events = [];
  let lastErr;
  for (const chunk of chunks) {
    try {
      events.push(...await extractChunk({ ...meta, content: chunk }));
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr && events.length === 0) throw lastErr;
  return events;
}

async function extractChunk({ title, content, pubDate, neighborhood }) {
  const prompt = `Extract event information from this NYC neighborhood blog post.

Blog post title: ${title}
Published: ${pubDate ?? 'unknown'}
Neighborhood context: ${neighborhood ?? 'NYC'}
Content:
${content}

This post may mention 0, 1, or multiple distinct events.
For EACH event extract the fields below. If the post is not about specific upcoming events (news, opinions, restaurant reviews), return an empty array.
Only include things a person can attend at a specific date and place. Do NOT include: stores, restaurants or venues opening or reopening; laws, rules or programs taking effect; application or registration windows; polls or votes; volunteer shifts; events the post says are cancelled or postponed without a new date; transit service changes; court dates; holidays and closures; TV broadcasts, episodes or announcements; movie releases; anything outside New York City.

Return ONLY valid JSON:
{
  "events": [
    {
      "title": "event name",
      "description": "brief description (1-3 sentences)",
      "startDate": "YYYY-MM-DD or null",
      "endDate": "YYYY-MM-DD or null",
      "time": "h:mm AM/PM or null",
      "location": {
        "name": "venue name or null",
        "address": "street address or null",
        "city": "New York"
      },
      "price": {
        "isFree": true,
        "min": null,
        "max": null,
        "currency": "USD"
      },
      "ticketUrl": "url or null",
      "categories": [],
      "tags": []
    }
  ]
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 8000,
  });

  const choice = response.choices[0];
  if (choice.finish_reason === 'length') throw new Error('LLM output truncated (max_tokens)');
  const parsed = parseJSON(choice.message.content);
  return Array.isArray(parsed.events) ? parsed.events : [];
}

/**
 * Lightweight classifier: does this RSS item look like it contains event info?
 * Uses heuristics first to avoid LLM calls for obvious non-events.
 */
export function looksLikeEventPost(title, content) {
  const text = `${title} ${content}`.toLowerCase();
  const eventKeywords = [
    'event', 'tonight', 'this weekend', 'saturday', 'sunday', 'monday',
    'tuesday', 'wednesday', 'thursday', 'friday', 'free', 'tickets',
    'festival', 'concert', 'market', 'fair', 'exhibit', 'workshop',
    'performance', 'show', 'opening', 'screening', 'tour', 'walk',
    'class', 'lecture', 'reading', 'popup', 'pop-up', 'celebration',
  ];
  return eventKeywords.some(kw => text.includes(kw));
}
