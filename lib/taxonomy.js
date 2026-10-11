import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {{ buckets: {key:string,label:string,emoji:string}[], keywordMap: Record<string,string>, priority: string[], kidKeywords: string[] }} */
const taxonomy = JSON.parse(
  readFileSync(join(__dirname, 'taxonomy.data.json'), 'utf-8'),
);

const KEYWORD_ENTRIES = Object.entries(taxonomy.keywordMap);

// Relative signal strength when merging raw categories with the title/tags.
// A raw category is what the source explicitly filed the event under, so it
// outweighs a word that merely appears in the title.
const WEIGHT_RAW = 3;
const WEIGHT_TITLE = 2;
const WEIGHT_TAG = 2;

/**
 * Match buckets from a single text string via substring lookup.
 * @param {string} text
 * @returns {Set<string>}
 */
function matchText(text) {
  const lc = String(text ?? '').toLowerCase().trim();
  const matched = new Set();
  if (!lc) return matched;
  for (const [kw, bucket] of KEYWORD_ENTRIES) {
    if (lc.includes(kw)) matched.add(bucket);
  }
  return matched;
}

/**
 * Deterministic canonical normalizer with a weighted merge.
 *
 * Every input contributes a bucket and a weight: raw categories (strongest),
 * then the title, then tags. The old gate read the title only when the raw
 * categories were empty or a lone generic `community`, so a raw-but-wrong
 * category silently suppressed a good title match (e.g. raw `Music` + title
 * "Yoga in the Park" never saw `wellness`). The merge now always considers all
 * three; a bucket enters `canonical` when it has any signal, and `primary` is
 * still chosen by the taxonomy's priority order, so a strong raw category keeps
 * leading while a supporting title/tag bucket is preserved alongside it.
 *
 * @param {string[]} rawCategories  Raw category strings from the crawler source
 * @param {string}   title          Event title
 * @param {string[]} tags           Event tags
 * @returns {{ canonical: string[], primary: string, isFamily: boolean, unmatched: string[] }}
 */
export function normalizeCategory(rawCategories, title, tags) {
  const weights = new Map();
  const add = (bucket, w) => weights.set(bucket, (weights.get(bucket) ?? 0) + w);

  // Pass 1: raw categories (strongest signal)
  const unmatched = [];
  for (const raw of rawCategories ?? []) {
    const buckets = matchText(raw);
    if (buckets.size > 0) {
      for (const b of buckets) add(b, WEIGHT_RAW);
    } else {
      unmatched.push(raw);
    }
  }

  // Pass 2: title + tags (always considered — a raw-but-wrong category must not
  // hide a good title match)
  for (const b of matchText(title)) add(b, WEIGHT_TITLE);
  for (const tag of tags ?? []) {
    for (const b of matchText(tag)) add(b, WEIGHT_TAG);
  }

  // Family detection: any signal hit OR a kid-keyword in title/tags
  const titleLc = (title ?? '').toLowerCase();
  const tagsLc = (tags ?? []).map(t => String(t).toLowerCase());
  const isFamily =
    weights.has('family') ||
    taxonomy.kidKeywords.some(kw => titleLc.includes(kw)) ||
    tagsLc.some(tag => taxonomy.kidKeywords.some(kw => tag.includes(kw)));
  if (isFamily) add('family', 1);

  const canonical = Array.from(weights.keys());

  // Absolute fallback: map to community
  if (canonical.length === 0) {
    return {
      canonical: ['community'],
      primary: 'community',
      isFamily: false,
      unmatched: (rawCategories ?? []).slice(),
    };
  }

  // Primary: first bucket in priority order that is in canonical
  let primary = 'community';
  for (const key of taxonomy.priority) {
    if (weights.has(key)) {
      primary = key;
      break;
    }
  }

  return { canonical, primary, isFamily, unmatched };
}

export const BUCKETS = taxonomy.buckets;
export const TAXONOMY = taxonomy;
