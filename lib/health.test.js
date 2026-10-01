import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth } from './health.js';

const now = new Date('2026-10-01T12:00:00Z');
const hoursAgo = h => new Date(now.getTime() - h * 3600_000).toISOString();
const run = (source_name, h, status, events_found = 0, error_messages = []) =>
  ({ source_name, started_at: hoursAgo(h), status, events_found, error_messages });
const keys = problems => problems.map(p => p.key).sort();

describe('evaluateHealth', () => {
  it('is quiet when sources produce events and the feed is full', () => {
    const problems = evaluateHealth({
      configs: [{ source_name: 'riverside-park', enabled: true }],
      runs: [run('riverside-park', 6, 'success', 148), run('riverside-park', 12, 'partial', 140, ['x'])],
      upcoming7d: 150, now,
    });
    assert.deepEqual(problems, []);
  });

  it('flags 3 errors in a row and a source with no events for 48h', () => {
    const problems = evaluateHealth({
      configs: [{ source_name: 'nyc-parks', enabled: true }],
      runs: [
        run('nyc-parks', 6, 'error', 0, ['HTTP 405']),
        run('nyc-parks', 12, 'error'),
        run('nyc-parks', 18, 'error'),
        run('nyc-parks', 72, 'success', 1200),
      ],
      upcoming7d: 150, now,
    });
    assert.deepEqual(keys(problems), ['nyc-parks:failing', 'nyc-parks:stale']);
    assert.match(problems[0].text, /failed its last 3 runs\. Last error: `HTTP 405`/);
  });

  it('does not count a streak broken by a success, or in-progress runs', () => {
    const problems = evaluateHealth({
      configs: [{ source_name: 'a', enabled: true }],
      runs: [run('a', 1, 'running'), run('a', 6, 'error'), run('a', 12, 'error'), run('a', 18, 'success', 5), run('a', 24, 'error')],
      upcoming7d: 150, now,
    });
    assert.deepEqual(problems, []);
  });

  it('flags "success" runs that find nothing, and sources with no runs at all', () => {
    const problems = evaluateHealth({
      configs: [{ source_name: 'a', enabled: true }, { source_name: 'b', enabled: true }],
      runs: [run('a', 6, 'success', 0), run('a', 60, 'success', 3)],
      upcoming7d: 150, now,
    });
    assert.deepEqual(keys(problems), ['a:stale', 'b:stale']);
  });

  it('ignores disabled sources and sources without a config row', () => {
    const problems = evaluateHealth({
      configs: [{ source_name: 'off', enabled: false }],
      runs: [run('off', 6, 'error'), run('off', 12, 'error'), run('off', 18, 'error'), run('gone', 6, 'error')],
      upcoming7d: 150, now,
    });
    assert.deepEqual(problems, []);
  });

  it('flags a thin feed', () => {
    const problems = evaluateHealth({ configs: [], runs: [], upcoming7d: 40, now });
    assert.deepEqual(keys(problems), ['upcoming:low']);
  });

  it('strips query strings and newlines from the error shown', () => {
    const problems = evaluateHealth({
      configs: [{ source_name: 'a', enabled: true }],
      runs: [1, 2, 3].map(h => run('a', h, 'error', 0, ['GET https://x.test/api?client_id=SECRET failed\nline 2'])),
      upcoming7d: 150, now,
    });
    assert.match(problems[0].text, /`GET https:\/\/x\.test\/api\?… failed line 2`/);
    assert.doesNotMatch(problems[0].text, /SECRET/);
  });
});
