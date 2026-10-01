import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CRAWLERS, runCrawler, expectedPath } from '../fixtures/harness.js';

// Each enabled crawler runs end to end against a saved copy of its source
// (fixtures/<crawler>/), and must produce exactly the events in expected.json.
// After an intentional parser change: npm run fixtures:expected, then review the diff.

describe('crawler fixtures', () => {
  for (const crawler of CRAWLERS) {
    it(`${crawler} turns its saved snapshot into the expected events`, async () => {
      const expected = JSON.parse(fs.readFileSync(expectedPath(crawler), 'utf8'));
      assert.ok(expected.length > 0, 'expected.json has no events');

      const events = await runCrawler(crawler);

      for (const e of events) {
        assert.match(e.id, /^[0-9a-f]{16}$/, `bad id on "${e.title}"`);
        assert.ok(e.title?.trim(), `missing title (${e.sourceUrl})`);
        assert.ok(e.source, `missing source on "${e.title}"`);
        assert.ok(e.sourceUrl, `missing sourceUrl on "${e.title}"`);
        assert.ok(e.startDate, `missing startDate on "${e.title}"`);
        assert.ok(Array.isArray(e.images), `images not an array on "${e.title}"`);
      }

      assert.equal(events.length, expected.length, 'event count changed');
      events.forEach((e, i) => assert.deepEqual(e, expected[i], `event ${i} ("${expected[i].title}") changed`));
    });
  }
});
