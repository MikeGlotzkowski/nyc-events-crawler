import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapPool } from './pool.js';

describe('mapPool', () => {
  it('returns results in input order', async () => {
    const out = await mapPool([1, 2, 3, 4, 5], 3, async (n) => {
      await new Promise((r) => setTimeout(r, (6 - n) * 2));
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
  });

  it('never has more than `limit` calls in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapPool(Array.from({ length: 40 }, (_, i) => i), 6, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    assert.ok(maxInFlight <= 6, `expected <= 6 in flight, saw ${maxInFlight}`);
    assert.ok(maxInFlight >= 2, `expected the pool to parallelise, saw ${maxInFlight}`);
  });

  it('runs strictly serially when limit is 1', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapPool([1, 2, 3], 1, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    assert.equal(maxInFlight, 1);
  });

  it('handles empty input and limits above the item count', async () => {
    assert.deepEqual(await mapPool([], 8, async () => 'x'), []);
    const out = await mapPool(['a', 'b'], 100, async (s) => s.toUpperCase());
    assert.deepEqual(out, ['A', 'B']);
  });

  it('propagates a rejection from fn', async () => {
    await assert.rejects(
      () => mapPool([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); }),
      /boom/,
    );
  });
});
