import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

// Set API key before importing module
process.env.OPENROUTER_API_KEY = 'test-key';

const { chatJSON } = await import('./openrouter.js');

describe('chatJSON', () => {
  it('returns parsed JSON and usage on success', async () => {
    const fakeResponse = {
      choices: [{ message: { content: '{"tags":["chill"]}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => fakeResponse,
    });

    try {
      const result = await chatJSON([{ role: 'user', content: 'test' }]);
      assert.deepEqual(result.json, { tags: ['chill'] });
      assert.equal(result.usage.prompt_tokens, 10);
      assert.equal(result.usage.completion_tokens, 5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses fenced JSON blocks', async () => {
    const fakeResponse = {
      choices: [{ message: { content: '```json\n{"key":"value"}\n```' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => fakeResponse,
    });

    try {
      const result = await chatJSON([{ role: 'user', content: 'test' }]);
      assert.deepEqual(result.json, { key: 'value' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws clearly on non-200 response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });

    try {
      await assert.rejects(
        () => chatJSON([{ role: 'user', content: 'test' }]),
        /OpenRouter 429/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
