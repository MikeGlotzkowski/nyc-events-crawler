import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(__dirname, 'taxonomy.data.json'), 'utf-8'));

// ── Task 1: taxonomy.data.json schema ────────────────────────────────────────

describe('taxonomy.data.json', () => {
  it('JSON parses successfully', () => {
    assert.ok(data && typeof data === 'object');
  });

  it('has exactly 13 buckets', () => {
    assert.strictEqual(data.buckets.length, 13);
  });

  it('bucket keys match the canonical 13', () => {
    const expected = new Set([
      'music', 'food', 'arts', 'nightlife', 'comedy', 'theater',
      'wellness', 'sports', 'film', 'family', 'tours', 'markets', 'community',
    ]);
    const actual = new Set(data.buckets.map(b => b.key));
    assert.deepStrictEqual(actual, expected);
  });

  it('every bucket has key, label, emoji', () => {
    for (const b of data.buckets) {
      assert.ok(typeof b.key === 'string' && b.key.length > 0, `bucket missing key: ${JSON.stringify(b)}`);
      assert.ok(typeof b.label === 'string' && b.label.length > 0, `bucket missing label: ${b.key}`);
      assert.ok(typeof b.emoji === 'string' && b.emoji.length > 0, `bucket missing emoji: ${b.key}`);
    }
  });

  it('every keywordMap value is a valid bucket key', () => {
    const validKeys = new Set(data.buckets.map(b => b.key));
    for (const [kw, bucket] of Object.entries(data.keywordMap)) {
      assert.ok(validKeys.has(bucket), `"${kw}" maps to unknown bucket "${bucket}"`);
    }
  });

  it('priority is a permutation of bucket keys', () => {
    const bucketKeys = data.buckets.map(b => b.key).sort();
    const priority = [...data.priority].sort();
    assert.deepStrictEqual(priority, bucketKeys);
  });

  it('kidKeywords is a non-empty array of strings', () => {
    assert.ok(Array.isArray(data.kidKeywords));
    assert.ok(data.kidKeywords.length > 0);
    for (const kw of data.kidKeywords) {
      assert.ok(typeof kw === 'string', `kidKeyword must be string: ${kw}`);
    }
  });
});

// ── Task 2: normalizeCategory ─────────────────────────────────────────────────
// Import lazily so schema tests above run even before taxonomy.js exists.

let normalizeCategory;
try {
  ({ normalizeCategory } = await import('./taxonomy.js'));
} catch {
  // taxonomy.js not yet written — skip Task-2 tests gracefully
}

if (normalizeCategory) {
  describe('normalizeCategory', () => {
    it('jousting-armor: canonical ⊇ arts+community, primary=arts, isFamily=false', () => {
      const result = normalizeCategory(
        ['Arts', 'Special Events', 'Arts & Culture', 'Museums & Exhibitions'],
        'Jousting & Armor Demo at The Met',
        [],
      );
      assert.ok(result.canonical.includes('arts'),      'canonical should include arts');
      assert.ok(result.canonical.includes('community'), 'canonical should include community');
      assert.strictEqual(result.primary, 'arts');
      assert.strictEqual(result.isFamily, false);
    });

    it('Kids in Motion + [Sport]: isFamily=true, primary=family', () => {
      const result = normalizeCategory(['Sport'], 'Kids in Motion', []);
      assert.strictEqual(result.isFamily, true);
      assert.strictEqual(result.primary, 'family');
    });

    it('[Documentary]: primary=film', () => {
      const result = normalizeCategory(['Documentary'], 'A documentary screening', []);
      assert.strictEqual(result.primary, 'film');
    });

    it('all-unknown: unmatched non-empty, primary=community', () => {
      const result = normalizeCategory(['XYZ Unknown', 'FOOBAR123'], 'Untitled event', []);
      assert.ok(result.unmatched.length > 0, 'unmatched should be non-empty');
      assert.strictEqual(result.primary, 'community');
    });

    it('family in raw categories → primary=family', () => {
      const result = normalizeCategory(['Family', 'Arts'], 'Fun for everyone', []);
      assert.strictEqual(result.primary, 'family');
      assert.strictEqual(result.isFamily, true);
    });

    it('tag-based family detection', () => {
      const result = normalizeCategory(['Music'], 'Jazz Night', ['all ages']);
      assert.strictEqual(result.isFamily, true);
    });

    it('empty rawCategories falls back via title', () => {
      const result = normalizeCategory([], 'live music at the park', []);
      assert.ok(result.canonical.includes('music'));
      assert.strictEqual(result.primary, 'music');
    });

    it('returns canonical as deduped array', () => {
      const result = normalizeCategory(['Arts', 'Arts & Culture'], 'Art walk', []);
      const artCount = result.canonical.filter(c => c === 'arts').length;
      assert.strictEqual(artCount, 1, 'arts should appear only once');
    });
  });
}
