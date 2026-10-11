/**
 * One price parser for every crawler (B5).
 *
 * Sources describe price as free text: "free", "no charge", "$20", "$29.50-$55.50",
 * "from $15", "$10 / $15", "0", "". Before this each crawler parsed it its own way
 * (nyc-parks, van-cortlandt-park, resident-advisor, calendar-harvest), so the same
 * string could mean different things depending on which source produced it. This is
 * the single parser; crawlers call it and hand the result to the shared event schema.
 *
 * Output is the shared price object { isFree, min, max, currency }:
 *   - isFree true  — "free"/"no charge"/0 (all amounts zero)
 *   - min & max    — a range ("29.50-55.50"), or the exact price of a single amount
 *   - max null     — a single amount with an open upper bound ("$20+", "from $15")
 *   - all null     — nothing parseable; an absent/unknown price is NOT "free"
 *
 * `freeWhenEmpty` is per source: for a park or community calendar an empty cost
 * means the event is free, but for a ticketing source a missing price is just
 * unknown.
 */

const AMOUNT_RE = /\d+(?:\.\d{1,2})?/g;
const FREE_RE = /\bfree\b|\bno charge\b|\bcomplimentary\b|\bno cost\b/i;
// A single amount reads as "at least this much" when the text says so.
const OPEN_RE = /\+|\bfrom\b|\bstarting\b|\band up\b|\bor more\b|\bup\b/i;

export function unknownPrice() {
  return { isFree: null, min: null, max: null, currency: 'USD' };
}

function currencyOf(s) {
  if (s.includes('\u20ac')) return 'EUR';
  if (s.includes('\u00a3')) return 'GBP';
  return 'USD';
}

/**
 * Free-text price → { isFree, min, max, currency }.
 * @param {string|null|undefined} text
 * @param {{freeWhenEmpty?: boolean}} [opts]
 */
export function parsePrice(text, { freeWhenEmpty = false } = {}) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) {
    return freeWhenEmpty
      ? { isFree: true, min: 0, max: 0, currency: 'USD' }
      : unknownPrice();
  }

  const currency = currencyOf(raw);
  const amounts = [...raw.matchAll(AMOUNT_RE)].map((m) => Number(m[0])).filter(Number.isFinite);

  // "free"/"no charge", or every amount is zero ("$0", "0", "00").
  if (FREE_RE.test(raw) || (amounts.length > 0 && amounts.every((a) => a === 0))) {
    return { isFree: true, min: 0, max: 0, currency };
  }
  if (amounts.length === 0) return unknownPrice();
  if (amounts.length === 1) {
    const v = amounts[0];
    return { isFree: false, min: v, max: OPEN_RE.test(raw) ? null : v, currency };
  }
  return { isFree: false, min: Math.min(...amounts), max: Math.max(...amounts), currency };
}

/** A structured cents amount (APIs that price in minor units, e.g. DICE) → the shared shape. */
export function priceFromCents(cents, currency = 'USD') {
  if (!Number.isFinite(cents)) return unknownPrice();
  return { isFree: cents === 0, min: cents / 100, max: null, currency: currency || 'USD' };
}
