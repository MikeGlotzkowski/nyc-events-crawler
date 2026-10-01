import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkContent } from './llm-extract.js';

test('short posts stay a single chunk', () => {
  assert.deepEqual(chunkContent('one event tonight'), ['one event tonight']);
});

test('long posts split on line breaks without losing text', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `event ${i}: something fun at a venue.`);
  const content = lines.join('\n');
  const chunks = chunkContent(content, 2000, 10);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(c => c.length <= 2000));
  assert.equal(chunks.join('\n'), content);
});

test('caps the number of chunks', () => {
  const chunks = chunkContent('x. '.repeat(10000), 1000, 3);
  assert.equal(chunks.length, 3);
});
