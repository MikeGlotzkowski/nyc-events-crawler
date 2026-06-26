import { loadEnv } from '../env-loader.js';

loadEnv();

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.5-flash';

function parseJSON(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = match ? match[1] : trimmed;
  return JSON.parse(jsonStr);
}

/**
 * Call OpenRouter with structured JSON output.
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ maxTokens?: number }} opts
 * @returns {Promise<{ json: any, usage: { prompt_tokens: number, completion_tokens: number } }>}
 */
export async function chatJSON(messages, { maxTokens = 512 } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://nomorefomo.app',
      'X-Title': 'NO MORE FOMO',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenRouter ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? '';
  const json = parseJSON(content);
  const usage = data.usage ?? { prompt_tokens: 0, completion_tokens: 0 };

  return { json, usage };
}
