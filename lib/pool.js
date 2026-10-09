/**
 * Shared bounded-concurrency helper.
 *
 * Runs `fn(item, index)` over `items` with at most `limit` calls in flight.
 * This is the scheduling primitive behind the batch upsert; the calendar-harvest
 * and image-backfill crawlers keep private copies with identical semantics.
 *
 * Correctness notes:
 *  - `results` is filled by index, so the return order matches the input order.
 *  - `size` is always >= 1 (empty input returns [] without spawning work).
 *  - A rejection from `fn` rejects the returned promise (Promise.all), matching a
 *    plain `await` loop.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit  max in flight (coerced to >= 1 and <= items.length)
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>} results in input order
 */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
