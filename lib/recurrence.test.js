import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRrule, parseCadence, seriesId, seriesSelector, capOccurrences, SERIES_CAP,
} from './recurrence.js';

describe('parseRrule', () => {
  it('normalises an iCal RRULE', () => {
    assert.deepEqual(
      parseRrule('FREQ=WEEKLY;UNTIL=20261201T235959Z;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR'),
      { freq: 'weekly', interval: 1, byDay: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], count: null, until: '20261201T235959Z', raw: 'FREQ=WEEKLY;UNTIL=20261201T235959Z;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR' },
    );
    assert.equal(parseRrule('FREQ=DAILY;COUNT=2;INTERVAL=22').freq, 'daily');
    assert.equal(parseRrule('FREQ=DAILY;COUNT=2;INTERVAL=22').count, 2);
    assert.equal(parseRrule('FREQ=MONTHLY;BYDAY=-1SA').freq, 'monthly');
    assert.equal(parseRrule('FREQ=DAILY;UNTIL=20261014T130000Z').until, '20261014T130000Z');
  });

  it('accepts a node-ical rrule object', () => {
    const r = parseRrule({ freq: 'WEEKLY', interval: 1, byday: ['we'], toString: () => 'FREQ=WEEKLY;BYDAY=WE' });
    assert.equal(r.freq, 'weekly');
  });

  it('returns null without a FREQ', () => {
    assert.equal(parseRrule(''), null);
    assert.equal(parseRrule(null), null);
    assert.equal(parseRrule('BYDAY=MO'), null);
  });
});

describe('parseCadence', () => {
  it('reads "every <weekday>"', () => {
    assert.deepEqual(parseCadence('Every Wednesday'), { freq: 'weekly', interval: 1, byDay: ['wednesday'] });
    assert.deepEqual(parseCadence('every Friday at 6pm'), { freq: 'weekly', interval: 1, byDay: ['friday'] });
  });

  it('reads multiple days and abbreviations', () => {
    const c = parseCadence('every Tuesday and Thursday');
    assert.equal(c.freq, 'weekly');
    assert.deepEqual(c.byDay.sort(), ['thursday', 'tuesday']);
    assert.deepEqual(parseCadence('every Wed').byDay, ['wednesday']);
  });

  it('reads numbered and "every other" intervals', () => {
    assert.deepEqual(parseCadence('every 2 weeks'), { freq: 'weekly', interval: 2, byDay: [] });
    assert.deepEqual(parseCadence('every other Saturday'), { freq: 'weekly', interval: 2, byDay: ['saturday'] });
    assert.deepEqual(parseCadence('daily'), { freq: 'daily', interval: 1, byDay: [] });
    assert.deepEqual(parseCadence('weekly'), { freq: 'weekly', interval: 1, byDay: [] });
    assert.deepEqual(parseCadence('monthly meetup'), { freq: 'monthly', interval: 1, byDay: [] });
  });

  it('returns null without cadence wording', () => {
    assert.equal(parseCadence('Live jazz at 7pm'), null);
    assert.equal(parseCadence(''), null);
    assert.equal(parseCadence(null), null);
  });
});

describe('seriesId', () => {
  it('is stable for the same source+selector and distinct otherwise', () => {
    const a = seriesId({ source: 'NYU', selector: 'https://x/event/1' });
    assert.equal(a, seriesId({ source: 'NYU', selector: 'https://x/event/1' }));
    assert.notEqual(a, seriesId({ source: 'NYU', selector: 'https://x/event/2' }));
    assert.notEqual(a, seriesId({ source: 'BPL', selector: 'https://x/event/1' }));
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  it('prefers seriesKey, then url, then title', () => {
    assert.equal(seriesSelector({ seriesKey: 'k', url: 'u', title: 't' }), 'k');
    assert.equal(seriesSelector({ url: 'u', title: 't' }), 'u');
    assert.equal(seriesSelector({ title: 't' }), 't');
    assert.equal(seriesSelector({}), '');
  });
});

describe('capOccurrences', () => {
  it('keeps order and caps a long series', () => {
    const list = Array.from({ length: 200 }, (_, i) => i);
    assert.deepEqual(capOccurrences(list, 3), [0, 1, 2]);
    assert.equal(capOccurrences(list).length, SERIES_CAP);
    assert.deepEqual(capOccurrences([1, 2], 5), [1, 2]);
    assert.deepEqual(capOccurrences(null), null);
  });
});
