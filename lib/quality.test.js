import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildQualityReport } from './quality.js';

const now = new Date('2026-10-01T23:30:00Z');
const hoursAgo = h => new Date(now.getTime() - h * 3600_000).toISOString();
const ev = (source, h, fields = {}) => ({
  source, title: `${source} event`, start_at: '2026-10-05T23:00:00Z', created_at: hoursAgo(h),
  image: 'https://x/img.jpg', time: '7:00 PM', canonical_category: 'music', borough: 'Manhattan', ...fields,
});
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

describe('buildQualityReport', () => {
  it('summarizes crawls, coverage and a title sample without problems', () => {
    const { markdown, problems } = buildQualityReport({
      runs: [
        { source_name: 'bam', status: 'success', events_found: 97, events_new: 3, error_count: 0 },
        { source_name: 'bam', status: 'partial', events_found: 95, events_new: 0, error_count: 2 },
      ],
      events: [ev('BAM', 2), ev('BAM', 72, { image: null }), ev('BAM', 72, { time: ' ' })],
      now,
    });
    assert.deepEqual(problems, []);
    assert.match(markdown, /\| bam \| 2 \| 192 \| 3 \| 2 \| partial, success \|/);
    // all upcoming / new: 2 of 3 have an image, the 1 new one does
    assert.match(markdown, /\| BAM \| 3 \| 1 \| 67 \/ 100 \| 67 \/ 100 \| 100 \/ 100 \| 100 \/ 100 \|/);
    assert.match(markdown, /### 3 random upcoming events/);
  });

  it('flags a field that new events lost, only with enough of both', () => {
    const events = [
      ...many(12, () => ev('Lincoln Center', 2, { image: null })),
      ...many(12, () => ev('Lincoln Center', 72)),
      // too few older events to compare
      ...many(12, () => ev('DICE', 2, { borough: null })),
      ...many(3, () => ev('DICE', 72)),
    ];
    const { problems, markdown } = buildQualityReport({ runs: [], events, now });
    assert.deepEqual(problems.map(p => p.key), ['Lincoln Center:quality-image']);
    assert.match(problems[0].text, /image on only 0% of 12 new events \(older upcoming ones: 100%\)/);
    assert.match(markdown, /### Degraded/);
  });

  it('keeps at most 10 titles and escapes table breakers', () => {
    const events = many(30, i => ev('Skint', 72, { title: `a|b\n<c> ${i}` }));
    const { markdown } = buildQualityReport({ runs: [], events, now, random: () => 0 });
    const titles = markdown.split('\n').filter(l => l.startsWith('- '));
    assert.equal(titles.length, 10);
    assert.ok(titles.every(t => t.includes('a b &lt;c>')));
  });
});
