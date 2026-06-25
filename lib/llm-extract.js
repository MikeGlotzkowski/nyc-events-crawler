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

/**
 * Extract structured events from a blog post.
 * Returns an array of partial RealEvent objects (0, 1, or many).
 */
export async function extractEventsFromPost({ title, content, pubDate, postUrl, neighborhood, borough }) {
  if (!openai) throw new Error('OPENAI_API_KEY not set');

  const prompt = `Extract event information from this NYC neighborhood blog post.

Blog post title: ${title}
Published: ${pubDate ?? 'unknown'}
Neighborhood context: ${neighborhood ?? 'NYC'}
Content:
${content.substring(0, 4000)}

This post may mention 0, 1, or multiple distinct events.
For EACH event extract the fields below. If the post is not about specific upcoming events (news, opinions, restaurant reviews), return an empty array.

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
    max_tokens: 2000,
  });

  const parsed = parseJSON(response.choices[0].message.content);
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
