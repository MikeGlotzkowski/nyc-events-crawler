/**
 * Canonical cross-source identity for events (B1).
 *
 * The per-source `fingerprint` in dedup.js only catches a row against its own
 * title|date|venue tuple within one source. This module answers a different
 * question: are two rows, from *different* sources, the same real-world event?
 *
 * Two stages, cheapest first:
 *   1. block  — same calendar date AND (same normalized venue OR a shared
 *               notable title prefix). Only blocked pairs are scored.
 *   2. score  — a weighted sum of title similarity, start-time proximity,
 *               coordinate proximity and ticket-host equality, compared
 *               against CANONICAL_MATCH_THRESHOLD.
 *
 * Two hard gates reject before scoring so recurring sessions never fuse:
 * rows whose calendar dates differ, and rows whose start times are further
 * apart than CANONICAL_TIME_WINDOW_MINUTES (a matinee vs an evening show).
 * Rows more than CANONICAL_COORD_MILES apart are also rejected.
 */

export const CANONICAL_MATCH_THRESHOLD = 0.55;
export const CANONICAL_COORD_MILES = 0.3;
export const CANONICAL_TIME_WINDOW_MINUTES = 120;

// Score weights (max = 0.5 title + 0.2 time + 0.25 coords + 0.15 host = 1.10).
const W_TITLE = 0.5;
const W_TIME = 0.2;
const W_COORD = 0.25;
const W_HOST = 0.15;

const MIN_TITLE_DICE = 0.5;      // below this the title carries no signal
const MIN_PREFIX_TOKENS = 2;     // a shared prefix this long is "notable"

// Words that don't distinguish one event from another.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'at', 'the', 'of', 'in', 'on', 'for', 'to', 'with', 'by',
  'feat', 'featuring', 'presents', 'presented', 'live', 'show', 'night',
  'nyc', 'new', 'york', 'city',
]);

// ── Text helpers ────────────────────────────────────────────────

/** Lowercase + NFKD-fold accents + strip punctuation, matching dedup.js. */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’‘]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Meaningful title tokens, in order, stopwords removed. */
export function titleTokens(s) {
  return normalizeText(s).split(' ').filter((t) => t && !STOPWORDS.has(t));
}

function tokenSet(tokens) {
  return new Set(tokens);
}

/** Sørensen–Dice coefficient over two token SETS (word order ignored). */
function diceCoefficient(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  return (2 * shared) / (setA.size + setB.size);
}

/** 0..1 title similarity. */
export function titleSimilarity(a, b) {
  return diceCoefficient(tokenSet(titleTokens(a)), tokenSet(titleTokens(b)));
}

/** True when both titles start with the same >=2 meaningful tokens (e.g. "Bonobo"). */
export function hasNotableTitlePrefix(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  const run = Math.min(ta.length, tb.length, MIN_PREFIX_TOKENS);
  if (run < MIN_PREFIX_TOKENS) return false;
  for (let i = 0; i < run; i++) if (ta[i] !== tb[i]) return false;
  return true;
}

function sameToken(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ── Time helpers ────────────────────────────────────────────────

const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;

/** 'YYYY-MM-DD' calendar day, or null. */
export function calendarDate(e) {
  const raw = e?.startDate ?? e?.start_date ?? null;
  if (raw == null) return null;
  const s = raw instanceof Date ? raw.toISOString() : String(raw);
  const m = s.match(DATE_RE);
  return m ? m[0] : null;
}

/** Minutes past midnight (NYC wall clock as written), or null when unknown. */
export function startMinutes(e) {
  const raw = e?.startDate ?? e?.start_date ?? null;
  const s = raw instanceof Date ? raw.toISOString() : String(raw ?? '');
  const iso = s.match(/T(\d{2}):(\d{2})/);
  if (iso) return Number(iso[1]) * 60 + Number(iso[2]);

  const text = String(e?.time ?? '');
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2] ?? 0);
}

// ── Geo ─────────────────────────────────────────────────────────

function coords(e) {
  const lat = e?.location?.lat;
  const lng = e?.location?.lng;
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** Great-circle distance in miles. */
export function milesApart(a, b) {
  const p = coords(a);
  const q = coords(b);
  if (!p || !q) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(q.lat - p.lat);
  const dLng = rad(q.lng - p.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(p.lat)) * Math.cos(rad(q.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 3958.7613 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function ticketHost(e) {
  const url = e?.ticketUrl;
  if (!url) return null;
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return null; }
}

// ── Decision ────────────────────────────────────────────────────

/** Same calendar date AND (same normalized venue OR shared notable title prefix). */
export function inSameBlock(a, b) {
  if (!calendarDate(a) || calendarDate(a) !== calendarDate(b)) return false;
  if (sameToken(a?.location?.name, b?.location?.name)) return true;
  return hasNotableTitlePrefix(a?.title, b?.title);
}

/**
 * Are a and b the same real-world event from different sources?
 * @returns {boolean}
 */
export function isSameEvent(a, b) {
  if (!a || !b) return false;
  if (!a.id || !b.id || a.id === b.id) return false;
  // Only cross-source pairs — the same source already handles its own dedup.
  if (!a.source || !b.source || a.source === b.source) return false;
  if (!calendarDate(a) || !calendarDate(b)) return false;
  if (!inSameBlock(a, b)) return false;

  // Time gate: both known and far apart (matinee vs evening) => distinct sessions.
  const ta = startMinutes(a);
  const tb = startMinutes(b);
  let time = null;
  if (ta != null && tb != null) {
    const gap = Math.abs(ta - tb);
    if (gap > CANONICAL_TIME_WINDOW_MINUTES) return false;
    time = W_TIME;
  }

  // Coordinate gate: both known and far apart => different venues.
  const dist = milesApart(a, b);
  let coord = null;
  if (dist != null) {
    if (dist > CANONICAL_COORD_MILES) return false;
    coord = W_COORD;
  }

  const dice = titleSimilarity(a.title, b.title);
  const title = dice >= MIN_TITLE_DICE ? W_TITLE * dice : 0;

  const ha = ticketHost(a);
  const hb = ticketHost(b);
  const host = ha && hb && ha === hb ? W_HOST : 0;

  const score = title + (time ?? 0) + (coord ?? 0) + host;
  return score >= CANONICAL_MATCH_THRESHOLD;
}

// ── Grouping ────────────────────────────────────────────────────

/** Quality signal of a row; the richest row in a group stays visible. */
export function eventRichness(e) {
  if (!e) return -1;
  let s = 0;
  s += Math.min(String(e.description ?? '').length, 2000) / 100; // ≤ 20
  s += (e.images?.length ?? 0) * 6;
  s += (e.categories?.length ?? 0) * 2;
  s += (e.tags?.length ?? 0) * 1;
  if (Number.isFinite(e.price?.min)) s += 1;
  if (Number.isFinite(e.price?.max)) s += 1;
  if (coords(e)) s += 4;
  if (e.location?.name) s += 1;
  if (e.ticketUrl) s += 1;
  s += Math.min(String(e.title ?? '').length, 120) / 40; // ≤ 3
  return s;
}

/**
 * Cluster cross-source duplicates. Each returned group has >= 2 members:
 *   { canonical, members, duplicates, dup_sources: [{ id, source }] }
 * Transitive: A~B and B~C put A, B and C in one group (connected components).
 *
 * Bucketed by calendar date first: `isSameEvent` already refuses to merge across
 * dates, so comparing every pair across a whole batch is wasted work and O(n^2)
 * at batch scale (a ticketing batch is thousands of rows).
 */
export function groupCanonical(events) {
  const list = Array.isArray(events) ? events.filter((e) => e && e.id) : [];
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { parent[find(i)] = find(j); };

  const byDate = new Map();
  list.forEach((e, i) => {
    const d = calendarDate(e) ?? '';
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(i);
  });
  for (const idxs of byDate.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        if (isSameEvent(list[idxs[a]], list[idxs[b]])) union(idxs[a], idxs[b]);
      }
    }
  }

  const byRoot = new Map();
  list.forEach((e, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(e);
  });

  const groups = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const canonical = members.reduce((best, m) => (eventRichness(m) > eventRichness(best) ? m : best));
    groups.push({
      canonical,
      members,
      duplicates: members.filter((m) => m !== canonical),
      dup_sources: members.map((m) => ({ id: m.id, source: m.source ?? null })),
    });
  }
  return groups;
}

/**
 * Build the durable linkage for a canonical group, merging the richest fields
 * from every member. Returns DB-ready values for the winner.
 */
export function mergeCanonicalFields(canonical, members = []) {
  const all = [canonical, ...members].filter((e) => e && e.id && e.id !== canonical.id);
  const everyone = [canonical, ...all];

  const images = [...new Set(everyone.flatMap((e) => e.images ?? []).filter(Boolean))];
  const withCoords = everyone.find((e) => coords(e));
  const description = everyone
    .map((e) => e.description)
    .filter((d) => typeof d === 'string' && d.trim())
    .sort((a, b) => b.length - a.length)[0] ?? null;
  const mins = everyone.map((e) => e.price?.min).filter((n) => Number.isFinite(n));
  const maxes = everyone.map((e) => e.price?.max).filter((n) => Number.isFinite(n));
  const price = mins.length > 0
    ? { min: Math.min(...mins), max: maxes.length > 0 ? Math.max(...maxes) : null, currency: 'USD' }
    : null;
  const ticketUrls = [...new Set(everyone.map((e) => e.ticketUrl).filter(Boolean))];
  const sourceUrls = [...new Set(everyone.map((e) => e.sourceUrl).filter(Boolean))];

  return {
    canonical_event_id: canonical.id,
    dup_sources: everyone.map((e) => ({ id: e.id, source: e.source ?? null })),
    image: images[0] ?? null,
    images,
    description,
    price,
    ticket_url: ticketUrls[0] ?? null,
    ticket_urls: ticketUrls,
    source_urls: sourceUrls,
    location: withCoords ? { lat: withCoords.location.lat, lng: withCoords.location.lng } : null,
  };
}
