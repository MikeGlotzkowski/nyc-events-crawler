import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint } from './dedup.js';

describe('fingerprint', () => {
  it('identical title/date/venue produce the same fingerprint', () => {
    const a = fingerprint('Jousting Armor Show', '2026-07-04', 'The Met');
    const b = fingerprint('Jousting Armor Show', '2026-07-04', 'The Met');
    assert.equal(a, b);
  });

  it('same title/venue but different dates produce different fingerprints', () => {
    const a = fingerprint('Jousting Armor Show', '2026-07-04', 'The Met');
    const b = fingerprint('Jousting Armor Show', '2026-07-05', 'The Met');
    assert.notEqual(a, b);
  });

  it('normalises punctuation/case so minor variations merge', () => {
    const a = fingerprint('Jousting Armor Show!', '2026-07-04', 'The Met');
    const b = fingerprint('jousting  armor  show', '2026-07-04', 'The Met');
    assert.equal(a, b);
  });

  it('null start_date produces a consistent fingerprint (does not throw)', () => {
    const a = fingerprint('Recurring Thing', null, 'Central Park');
    const b = fingerprint('Recurring Thing', null, 'Central Park');
    assert.equal(a, b);
  });

  it('null venue is handled gracefully', () => {
    const a = fingerprint('Concert', '2026-07-04', null);
    const b = fingerprint('Concert', '2026-07-04', null);
    assert.equal(a, b);
  });
});

describe('fingerprint normalization', () => {
  it('merges curly/straight quotes and HTML entities', () => {
    const a = fingerprint('It’s A Grand Old Flag', '2027-01-01', null);
    const b = fingerprint("It's A Grand Old Flag", '2027-01-01', null);
    const c = fingerprint('It&#8217;s A Grand Old Flag', '2027-01-01', null);
    assert.equal(a, b);
    assert.equal(a, c);
  });

  it('ignores accents and venue punctuation', () => {
    assert.equal(
      fingerprint('Café Alon Opening', '2026-11-01', 'W 68th Street &#038; Riverside Blvd'),
      fingerprint('Cafe Alon Opening', '2026-11-01', 'W 68th Street & Riverside Blvd.'),
    );
  });
});
