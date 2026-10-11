import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, priceFromCents, unknownPrice } from './price.js';

describe('parsePrice', () => {
  it('reads explicit free text', () => {
    for (const free of ['free', 'Free', 'FREE admission', 'No charge', 'no cost', 'complimentary']) {
      assert.deepEqual(parsePrice(free), { isFree: true, min: 0, max: 0, currency: 'USD' }, free);
    }
  });

  it('reads a zero amount as free', () => {
    for (const zero of ['0', '00', '$0', '$0.00', 'USD 0.00']) {
      assert.deepEqual(parsePrice(zero), { isFree: true, min: 0, max: 0, currency: 'USD' }, zero);
    }
  });

  it('reads a single amount as an exact price', () => {
    assert.deepEqual(parsePrice('$20'), { isFree: false, min: 20, max: 20, currency: 'USD' });
    assert.deepEqual(parsePrice('20'), { isFree: false, min: 20, max: 20, currency: 'USD' });
    assert.deepEqual(parsePrice('$25/20 for Members'), { isFree: false, min: 20, max: 25, currency: 'USD' });
  });

  it('reads an open-ended single amount ("from $x", "$x+") with a null max', () => {
    for (const open of ['$20+', 'from $15', 'starting at $10', '$18 and up']) {
      const p = parsePrice(open);
      assert.equal(p.isFree, false, open);
      assert.equal(p.max, null, open);
      assert.ok(p.min > 0, open);
    }
  });

  it('reads a range', () => {
    assert.deepEqual(parsePrice('$29.50-$55.50'), { isFree: false, min: 29.5, max: 55.5, currency: 'USD' });
    assert.deepEqual(parsePrice('29.50-55.50'), { isFree: false, min: 29.5, max: 55.5, currency: 'USD' });
    assert.deepEqual(parsePrice('$10 / $15'), { isFree: false, min: 10, max: 15, currency: 'USD' });
    assert.deepEqual(parsePrice('10.00 to 25.00'), { isFree: false, min: 10, max: 25, currency: 'USD' });
  });

  it('honours the currency symbol', () => {
    assert.equal(parsePrice('\u20ac10').currency, 'EUR');
    assert.equal(parsePrice('\u00a310').currency, 'GBP');
    assert.equal(parsePrice('$10').currency, 'USD');
  });

  it('treats empty as unknown, unless the source says empty means free', () => {
    assert.deepEqual(parsePrice(''), unknownPrice());
    assert.deepEqual(parsePrice(null), unknownPrice());
    assert.deepEqual(parsePrice(undefined), unknownPrice());
    assert.deepEqual(parsePrice(''), { isFree: null, min: null, max: null, currency: 'USD' });
    assert.deepEqual(parsePrice('', { freeWhenEmpty: true }), { isFree: true, min: 0, max: 0, currency: 'USD' });
    assert.deepEqual(parsePrice('   '), unknownPrice());
  });

  it('returns unknown for text with no amount and no free hint', () => {
    assert.deepEqual(parsePrice('suggested donation'), unknownPrice());
    assert.deepEqual(parsePrice('TBA'), unknownPrice());
  });
});

describe('priceFromCents', () => {
  it('converts minor units to the shared shape', () => {
    assert.deepEqual(priceFromCents(3994), { isFree: false, min: 39.94, max: null, currency: 'USD' });
    assert.deepEqual(priceFromCents(0), { isFree: true, min: 0, max: null, currency: 'USD' });
    assert.deepEqual(priceFromCents(NaN), unknownPrice());
    assert.equal(priceFromCents(1000, 'EUR').currency, 'EUR');
  });
});
