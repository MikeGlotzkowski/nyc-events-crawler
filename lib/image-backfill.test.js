/**
 * B6 — global image backfill.
 * Fixture/stub driven: no live network. global.fetch is stubbed per test; the
 * og-image cache is cleared between tests so memoisation is exercised per run.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearImageCache } from './og-image.js';
import { backfillImages, needsImageBackfill, createHostGate, BACKFILL_DEFAULTS } from './image-backfill.js';

const realFetch = globalThis.fetch;
const OG = 'https://cdn.example.com/fair.jpg';

const htmlRes = (html, { status = 200, url = 'https://example.com/event', type = 'text/html; charset=utf-8' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
  text: async () => html,
  body: undefined,
});

const pageWithOg = (src = OG) =>
  htmlRes(`<html><head><meta property="og:image" content="${src}"></head><body>hi</body></html>`);

let fetchCalls = [];
function stubFetch(impl) {
  fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push(String(url));
    return impl(String(url), opts);
  };
}

const ev = (over = {}) => ({ title: 'T', sourceUrl: 'https://example.com/event', images: [], ...over });

beforeEach(() => clearImageCache());
afterEach(() => { globalThis.fetch = realFetch; });

describe('needsImageBackfill', () => {
  it('is true only for an event with no image and an http(s) sourceUrl', () => {
    assert.equal(needsImageBackfill(ev()), true);
    assert.equal(needsImageBackfill(ev({ images: ['https://x/a.jpg'] })), false);
    assert.equal(needsImageBackfill(ev({ sourceUrl: null })), false);
    assert.equal(needsImageBackfill(ev({ sourceUrl: 'mailto:x@y.z' })), false);
    assert.equal(needsImageBackfill({ title: 'no url', images: [] }), false);
  });
});

describe('backfillImages', () => {
  it('extracts og:image for an event with no image and a sourceUrl', async () => {
    stubFetch(() => pageWithOg());
    const events = [ev()];
    const res = await backfillImages(events, { perHostDelayMs: 0 });

    assert.deepEqual(events[0].images, [OG]);
    assert.equal(res.filled, 1);
    assert.equal(res.fetched, 1);
  });

  it('leaves an event that already has an image untouched and never fetches it', async () => {
    stubFetch(() => pageWithOg());
    const keep = 'https://cdn.example.com/already.jpg';
    const events = [ev({ images: [keep] })];
    const res = await backfillImages(events, { perHostDelayMs: 0 });

    assert.deepEqual(events[0].images, [keep]);
    assert.equal(fetchCalls.length, 0);
    assert.equal(res.filled, 0);
  });

  it('leaves the event unchanged (no throw) when the page 404s', async () => {
    stubFetch(() => htmlRes('<html></html>', { status: 404 }));
    const events = [ev({ sourceUrl: 'https://example.com/gone' })];
    const res = await backfillImages(events, { perHostDelayMs: 0 });

    assert.deepEqual(events[0].images, []);
    assert.equal(res.filled, 0);
    assert.equal(res.fetched, 1);
  });

  it('leaves the event unchanged when the page has no usable image', async () => {
    stubFetch(() => pageWithOg('data:image/png;base64,AAAA')); // rejected by cleanImageUrl
    const events = [ev()];
    await backfillImages(events, { perHostDelayMs: 0 });
    assert.deepEqual(events[0].images, []);
  });

  it('never throws when the fetch rejects', async () => {
    stubFetch(() => { throw new Error('ECONNRESET'); });
    const events = [ev()];
    const res = await backfillImages(events, { perHostDelayMs: 0 });
    assert.deepEqual(events[0].images, []);
    assert.equal(res.filled, 0);
    assert.equal(res.fetched, 1);
    assert.equal(res.failed, 0); // og-image swallows the network error → nothing to fill
  });

  it('memoises by URL: one fetch for a URL shared by several events', async () => {
    stubFetch(() => pageWithOg());
    const events = [
      ev({ sourceUrl: 'https://example.com/same' }),
      ev({ sourceUrl: 'https://example.com/same' }),
      ev({ sourceUrl: 'https://example.com/same' }),
    ];
    const res = await backfillImages(events, { perHostDelayMs: 0 });

    assert.equal(fetchCalls.length, 1);
    assert.equal(res.filled, 3);
    assert.ok(events.every((e) => e.images[0] === OG));
  });

  it('bounds concurrency to the pool size', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    stubFetch(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return pageWithOg();
    });

    // distinct hosts so the per-host gate does not serialise them
    const events = Array.from({ length: 9 }, (_, i) => ev({ sourceUrl: `https://h${i}.example.com/e` }));
    await backfillImages(events, { concurrency: 3, perHostDelayMs: 0 });

    assert.ok(maxInFlight <= 3, `expected <=3 in flight, saw ${maxInFlight}`);
    assert.ok(maxInFlight >= 2, `expected the pool to run in parallel, saw ${maxInFlight}`);
  });

  it('respects the per-run page cap', async () => {
    stubFetch(() => pageWithOg());
    const events = Array.from({ length: 5 }, (_, i) => ev({ sourceUrl: `https://x${i}.example.com/e` }));
    const res = await backfillImages(events, { maxPages: 2, perHostDelayMs: 0 });

    assert.equal(fetchCalls.length, 2);
    assert.equal(res.fetched, 2);
    assert.equal(res.candidates, 5);
    assert.equal(res.filled, 2);
  });

  it('exposes sensible defaults', () => {
    assert.ok(BACKFILL_DEFAULTS.concurrency >= 1 && BACKFILL_DEFAULTS.concurrency <= 6);
    assert.ok(BACKFILL_DEFAULTS.perHostDelayMs > 0);
    assert.ok(BACKFILL_DEFAULTS.maxPages > 0);
  });
});

describe('createHostGate', () => {
  it('spaces successive requests to the same host by the delay', async () => {
    let now = 1000;
    const sleeps = [];
    const gate = createHostGate({
      delayMs: 500,
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });

    await gate.waitFor('https://a.com/1');
    await gate.waitFor('https://a.com/2');   // same host → waits
    await gate.waitFor('https://b.com/1');   // different host → no wait

    assert.deepEqual(sleeps, [500]);
  });

  it('does not wait when the delay is zero', async () => {
    const sleeps = [];
    const gate = createHostGate({ delayMs: 0, now: () => 1000, sleep: async (ms) => sleeps.push(ms) });
    await gate.waitFor('https://a.com/1');
    await gate.waitFor('https://a.com/2');
    assert.deepEqual(sleeps, []);
  });
});
