/**
 * B6 — Global image backfill.
 *
 * Given a batch of mapped events (the crawler shape, before upsert), fill in an image
 * for any event that has none but does have a `sourceUrl`, by fetching that page once
 * and reading its declared og:image / twitter:image / JSON-LD image via lib/og-image.js.
 *
 * Design:
 *   • bounded concurrency (small pool) — never fan out over a 6k-event batch,
 *   • a per-host politeness delay — never hammer one origin (e.g. one blog host), 
 *   • memoised by URL via og-image's own cache — a page is fetched at most once per run,
 *   • a per-run page cap — backfill is a quality *improvement*, not a crawl blocker,
 *   • never throws — a bad page is logged and skipped.
 *
 * The image-candidate list is event.images (the same field upsertEvent writes).
 */

import { fetchPageImage } from './og-image.js';

export const BACKFILL_DEFAULTS = {
  concurrency:  4,       // simultaneous page fetches
  perHostDelayMs: 1000,  // minimum gap between two requests to the same host
  maxPages:     500,     // per-run cap on page fetches (tradeoff: coverage vs. crawl time)
};

/** True when this event has no image and a fetchable http(s) sourceUrl. */
export function needsImageBackfill(event) {
  if (!event) return false;
  if (Array.isArray(event.images) && event.images.length > 0) return false;
  if (event.image) return false;
  const url = event.sourceUrl;
  if (typeof url !== 'string' || !url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A tiny per-host rate limiter. `waitFor(url)` resolves once it is polite to request
 * that host, recording the moment so the next request to the same host waits.
 */
export function createHostGate({ delayMs = BACKFILL_DEFAULTS.perHostDelayMs, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const lastAt = new Map(); // host → timestamp of the last request
  return {
    async waitFor(url) {
      if (delayMs <= 0) return;
      let host;
      try { host = new URL(url).host; } catch { return; }
      const last = lastAt.get(host);
      const t = now();
      if (last != null && t - last < delayMs) await sleep(delayMs - (t - last));
      lastAt.set(host, now());
    },
  };
}

/** Run `fn` over `items` with at most `limit` in flight. Mirrors calendar-harvest's pool. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Backfill images in place.
 * @param {Array<object>} events  mapped crawler events (mutated: `images` may be set)
 * @param {object} [opts]
 * @param {number} [opts.concurrency]    fetches in flight
 * @param {number} [opts.perHostDelayMs] minimum gap between requests to the same host
 * @param {number} [opts.maxPages]       cap on page fetches this run
 * @param {Function} [opts.logger]       (msg, meta) => void
 * @returns {Promise<{candidates:number, fetched:number, filled:number, failed:number, capped:boolean}>}
 */
export async function backfillImages(events = [], opts = {}) {
  const concurrency   = opts.concurrency   ?? BACKFILL_DEFAULTS.concurrency;
  const perHostDelayMs = opts.perHostDelayMs ?? BACKFILL_DEFAULTS.perHostDelayMs;
  const maxPages      = opts.maxPages      ?? BACKFILL_DEFAULTS.maxPages;
  const logger        = opts.logger        ?? (() => {});

  const candidates = events.filter(needsImageBackfill);
  const stats = { candidates: candidates.length, fetched: 0, filled: 0, failed: 0, capped: candidates.length > maxPages };
  if (candidates.length === 0) return stats;

  const target = candidates.slice(0, maxPages);
  const gate = createHostGate({ delayMs: perHostDelayMs });

  // Distinct URLs get fetched once; every event sharing a URL reuses the result
  // (og-image's fetchPageImage is itself memoised, so this is belt-and-braces).
  await mapPool(target, concurrency, async (event) => {
    try {
      await gate.waitFor(event.sourceUrl);
      stats.fetched++;
      const image = await fetchPageImage(event.sourceUrl);
      if (image) {
        event.images = [image];
        stats.filled++;
      }
    } catch (err) {
      stats.failed++;
      logger('image backfill failed', { url: event.sourceUrl, error: err?.message ?? String(err) });
    }
  });

  return stats;
}
