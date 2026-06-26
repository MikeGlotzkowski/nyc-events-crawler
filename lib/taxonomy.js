import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {{ buckets: {key:string,label:string,emoji:string}[], keywordMap: Record<string,string>, priority: string[], kidKeywords: string[] }} */
const taxonomy = JSON.parse(
  readFileSync(join(__dirname, 'taxonomy.data.json'), 'utf-8'),
);

const KEYWORD_ENTRIES = Object.entries(taxonomy.keywordMap);

/**
 * Match buckets from a single text string via substring lookup.
 * @param {string} text
 * @returns {Set<string>}
 */
function matchText(text) {
  const lc = text.toLowerCase().trim();
  const matched = new Set();
  for (const [kw, bucket] of KEYWORD_ENTRIES) {
    if (lc.includes(kw)) matched.add(bucket);
  }
  return matched;
}

/**
 * Deterministic canonical normalizer.
 *
 * @param {string[]} rawCategories  Raw category strings from the crawler source
 * @param {string}   title          Event title (used for family/fallback detection)
 * @param {string[]} tags           Event tags (used for family detection)
 * @returns {{ canonical: string[], primary: string, isFamily: boolean, unmatched: string[] }}
 */
export function normalizeCategory(rawCategories, title, tags) {
  const canonical = new Set();
  const unmatched = [];

  // Pass 1: raw categories
  for (const raw of rawCategories) {
    const buckets = matchText(raw);
    if (buckets.size > 0) {
      for (const b of buckets) canonical.add(b);
    } else {
      unmatched.push(raw);
    }
  }

  // Pass 2: title + tags (only when raw gave nothing)
  if (canonical.size === 0) {
    const fromTitle = matchText(title ?? '');
    for (const b of fromTitle) canonical.add(b);
    for (const tag of (tags ?? [])) {
      const fromTag = matchText(tag);
      for (const b of fromTag) canonical.add(b);
    }
  }

  // Family detection: canonical hit OR kid-keyword in title/tags
  const titleLc = (title ?? '').toLowerCase();
  const tagsLc = (tags ?? []).map(t => t.toLowerCase());
  const isFamily =
    canonical.has('family') ||
    taxonomy.kidKeywords.some(kw => titleLc.includes(kw)) ||
    tagsLc.some(tag => taxonomy.kidKeywords.some(kw => tag.includes(kw)));

  if (isFamily) canonical.add('family');

  // Absolute fallback: map to community
  if (canonical.size === 0) {
    return {
      canonical: ['community'],
      primary: 'community',
      isFamily: false,
      unmatched: rawCategories.slice(),
    };
  }

  // Primary: first bucket in priority order that is in canonical
  let primary = 'community';
  for (const key of taxonomy.priority) {
    if (canonical.has(key)) {
      primary = key;
      break;
    }
  }

  return {
    canonical: Array.from(canonical),
    primary,
    isFamily,
    unmatched,
  };
}

export const BUCKETS = taxonomy.buckets;
export const TAXONOMY = taxonomy;
