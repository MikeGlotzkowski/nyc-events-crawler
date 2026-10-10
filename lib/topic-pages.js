/**
 * Daily topic/collection-page generator.
 *
 * Produces ~50 short curated pages for the app's public collection route
 * (`/lists/:slug`), from the upcoming events already in Supabase. One page = one
 * `curated_lists` row + its `list_items`.
 *
 * Design:
 *   • Topics are a fixed, tunable list (TOPICS) built from the app's own taxonomy:
 *     time-intent, geo × category, and one hub per bucket.
 *   • Selection is deterministic (quality score, then start_date, then id) so a
 *     re-run with the same events rebuilds the same page.
 *   • Copy comes from the LLM (chatJSON) with a strict prompt, cached by a content
 *     hash so an unchanged page never re-spends; a deterministic template is used
 *     when the model is unavailable so the page still publishes.
 *   • Index discipline: a topic below MIN_EVENTS is written `published=false`
 *     (never deleted), so a URL that once worked does not 404.
 *   • Writes are idempotent: upsert curated_lists by slug, then replace that list's
 *     items (delete + insert), so re-runs update in place and never duplicate.
 *
 * Anything that touches the network (Supabase, OpenRouter) is a dependency that the
 * caller may swap, keeping the logic itself unit-testable with fixtures.
 */

import { createHash } from 'node:crypto';
import { BUCKETS } from './taxonomy.js';
import { log, logError } from './base-crawler.js';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Days a page's items span. Time-intent topics ignore this. */
export const WINDOW_DAYS = 30;

/** How many events to put on a page, by topic kind (`kind` → limit). */
export const PER_TOPIC = { default: 12, hub: 15, time: 10 };

/** A topic is published only at or above this many qualifying events. */
export const MIN_EVENTS = 6;

/** Featured categories for the geo × category block. Also tunable. */
export const FEATURED_CATEGORIES = ['music', 'comedy', 'film', 'arts', 'theater', 'food'];

/** Category → the word used inside a geo slug (`jazz-in-brooklyn`). */
export const CATEGORY_SLUG_WORD = {
  music: 'live-music',
  comedy: 'comedy',
  film: 'film',
  arts: 'art',
  theater: 'theater',
  food: 'food',
};

/** Bucket key → hub slug. All thirteen are used; the map keeps slugs explicit. */
const BUCKET_SLUG = {
  music: 'music',
  food: 'food',
  arts: 'arts',
  nightlife: 'nightlife',
  comedy: 'comedy',
  theater: 'theater',
  wellness: 'wellness',
  sports: 'sports',
  film: 'film',
  family: 'family',
  tours: 'tours',
  markets: 'markets',
  community: 'community',
};

/** Boroughs are the app's canonical five (lib/nyc-area.js). */
export const BOROUGH_SLUGS = [
  ['Manhattan', 'manhattan'],
  ['Brooklyn', 'brooklyn'],
  ['Queens', 'queens'],
  ['Bronx', 'bronx'],
  ['Staten Island', 'staten-island'],
];

/**
 * Time-intent topics. A `days` window is a *remaining* window: tonight covers the
 * current NYC day, this-weekend the next Sat+Sun, this-week the next 7 days.
 */
export const TIME_TOPICS = [
  { key: 'tonight', slug: 'tonight', title: 'Tonight in NYC', kind: 'time' },
  { key: 'this-weekend', slug: 'this-weekend', title: 'This Weekend in NYC', kind: 'time' },
  { key: 'this-week', slug: 'this-week', title: 'This Week in NYC', kind: 'time' },
  { key: 'free-this-weekend', slug: 'free-this-weekend', title: 'Free This Weekend in NYC', kind: 'time', free: true },
  { key: 'free-tonight', slug: 'free-tonight', title: 'Free Tonight in NYC', kind: 'time', free: true },
];

function geoTopics() {
  const out = [];
  for (const category of FEATURED_CATEGORIES) {
    const word = CATEGORY_SLUG_WORD[category];
    for (const [borough, slug] of BOROUGH_SLUGS) {
      out.push({
        slug: `${word}-in-${slug}`,
        title: `${titleCase(word)} in ${borough}`,
        kind: 'geo',
        category,
        borough,
      });
    }
  }
  // Free-events block reuses the geo machinery with the `free` filter.
  for (const [borough, slug] of BOROUGH_SLUGS) {
    out.push({
      slug: `free-events-in-${slug}`,
      title: `Free Events in ${borough}`,
      kind: 'geo',
      free: true,
      borough,
    });
  }
  return out;
}

function hubTopics() {
  return BUCKETS
    .map(b => ({
      slug: BUCKET_SLUG[b.key] ?? b.key,
      title: `${b.label} in NYC`,
      kind: 'hub',
      category: b.key,
    }));
}

/** The full ~50-topic list, in a stable order. */
export const TOPICS = [...TIME_TOPICS, ...geoTopics(), ...hubTopics()];

export function topicSlugs() {
  return TOPICS.map(t => t.slug);
}

function titleCase(s) {
  return s.replace(/(^|[\s-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

// ── NYC calendar helpers (pure) ──────────────────────────────────────────────

const NYC_TZ = 'America/New_York';

/** 'YYYY-MM-DD' in America/New_York for a Date. */
export function nycYmd(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: NYC_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  return p; // en-CA gives YYYY-MM-DD
}

/** Add `n` days to a 'YYYY-MM-DD'. */
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Day of week for 'YYYY-MM-DD' (0=Sun … 6=Sat), read as a UTC calendar date. */
export function weekdayOf(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

/**
 * Resolve a time-intent topic to the inclusive { from, to } NYC date window it
 * covers, `from` never earlier than `today`.
 *   tonight      → today
 *   this-weekend → today..the coming Sunday (or this Sunday if today is one)
 *   this-week    → today..today+6
 */
export function resolveWindow(key, today) {
  switch (key) {
    case 'tonight':
    case 'free-tonight':
      return { from: today, to: today };
    case 'this-weekend':
    case 'free-this-weekend': {
      const dow = weekdayOf(today);           // 0 Sun … 6 Sat
      const toSunday = (7 - dow) % 7;         // Sun → 0, Mon → 6, Sat → 1
      return { from: today, to: addDays(today, toSunday) };
    }
    case 'this-week':
      return { from: today, to: addDays(today, 6) };
    default:
      return { from: today, to: addDays(today, WINDOW_DAYS) };
  }
}

/** Parse a Postgres text[] (`{a,b}`) or a real JS array into a string array. */
function toStringArray(value) {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string');
  if (typeof value === 'string' && value.startsWith('{')) {
    return value.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  }
  return [];
}

/** The default event source: visible, upcoming rows, with the fields we rank on. */
export async function fetchUpcomingEvents(supabase, today) {
  const { data, error } = await supabase
    .from('events')
    .select('id, slug, title, start_date, end_date, time, image, borough, neighborhood, canonical_category, canonical_categories, is_free, price_min, venue, quality_score, hidden_reason, source')
    .is('hidden_reason', null)
    .gte('start_date', today)
    .order('start_date', { ascending: true })
    .limit(4000);
  if (error) throw new Error(`Supabase read failed: ${error.message}`);
  return (data ?? []).map(row => ({
    ...row,
    canonical_categories: toStringArray(row.canonical_categories),
    end_date: row.end_date ?? null,
  }));
}

// ── Selection ────────────────────────────────────────────────────────────────

/** True if the event overlaps the topic's window (ongoing events count as upcoming). */
export function inWindow(event, window) {
  const start = event.start_date;
  if (!start) return false;
  const end = event.end_date && event.end_date >= start ? event.end_date : start;
  return start <= window.to && end >= window.from;
}

/** Does this event qualify for the topic? */
export function qualifies(event, topic, today) {
  if (!event?.start_date) return false;
  if (event.hidden_reason) return false;
  // Time-intent topics always use their own narrow window; others use the global one.
  const window = topic.kind === 'time'
    ? resolveWindow(topic.key, today)
    : { from: today, to: addDays(today, WINDOW_DAYS) };
  if (!inWindow(event, window)) return false;

  if (topic.free && !(event.is_free === true || event.price_min === 0)) return false;
  if (topic.category) {
    const cats = event.canonical_categories ?? [];
    const primary = event.canonical_category;
    if (primary !== topic.category && !cats.includes(topic.category)) return false;
  }
  if (topic.borough && event.borough !== topic.borough) return false;
  return true;
}

/** Deterministic score — higher is a better card. */
export function score(event) {
  const hasImage = typeof event.image === 'string' && event.image && event.image !== 'null';
  return (
    (Number(event.quality_score) || 0)
    + (hasImage ? 15 : 0)
    + (event.time ? 10 : 0)
    + (event.start_date ? 20 : 0)
  );
}

const byScoreThenDate = (a, b) =>
  score(b) - score(a)
  || String(a.start_date).localeCompare(String(b.start_date))
  || String(a.id).localeCompare(String(b.id));

/**
 * Pick the best `n` events for a topic from `events`, deterministically.
 * @returns {Array}
 */
export function selectEvents(events, topic, today, n = PER_TOPIC.default) {
  return events
    .filter(e => qualifies(e, topic, today))
    .sort(byScoreThenDate)
    .slice(0, n);
}

// ── Copy ─────────────────────────────────────────────────────────────────────

/** sha1 over the slug, dates and ordered event titles — the copy cache key. */
export function contentHash(topic, events) {
  const text = [
    topic.slug,
    ...events.map(e => `${e.start_date}|${e.title}`),
  ].join('\n');
  return createHash('sha1').update(text).digest('hex');
}

/** One-line description and a 2–3 sentence intro, without the LLM. */
export function templateCopy(topic, events) {
  const first = events[0]?.start_date;
  const description = `${events.length} upcoming ${noun(topic)} in NYC${first ? `, from ${first}` : ''}.`;

  const byBorough = new Map();
  for (const e of events) {
    if (!e.borough) continue;
    byBorough.set(e.borough, (byBorough.get(e.borough) ?? 0) + 1);
  }
  const where = [...byBorough.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([b, c]) => `${c} in ${b}`)
    .join(', ');

  const intro = [
    `A hand-picked list of ${noun(topic)} happening around New York City, drawn from what the crawler has confirmed so far.`,
    where ? `Most are in ${where}.` : '',
    first ? `The earliest start listed is ${first}.` : '',
  ].filter(Boolean).join(' ');

  return { description, intro };
}

/**
 * One page's copy: strict LLM prompt, cached by content hash, deterministic
 * template fallback. Never throws.
 * @returns {{ description: string, intro: string, source: 'llm'|'template', cost: number, cached: boolean }}
 */
export async function generateCopy(topic, events, deps = {}) {
  const chat = deps.chatJSON;
  const cache = deps.cache;              // any { get(key), set(key, value) } (Map or Supabase-backed)
  const hash = `${topic.slug}:${contentHash(topic, events)}`;

  const cached = cache?.get ? await cache.get(hash) : undefined;
  if (cached) {
    return { ...cached, cached: true, cost: 0 };
  }

  let result = null;
  if (chat) {
    try {
      const lines = events.map((e, i) => {
        const where = e.venue?.name || e.neighborhood || e.borough || 'NYC';
        return `${i + 1}. ${e.title} — ${e.start_date}${e.time ? ` ${e.time}` : ''} — ${where}${e.is_free ? ' (free)' : ''}`;
      }).join('\n');

      const { json, usage } = await chat([{
        role: 'user',
        content:
          `Write copy for a NYC events collection page titled "${topic.title}".\n` +
          `Use ONLY the events listed below. Do not invent events, venues, dates or prices. ` +
          `Do not mention anything not shown. Plain declarative prose, no marketing hype, ` +
          `no exclamation marks, no "hidden gem", "must-see", "vibrant", "unforgettable".\n\n` +
          `Events:\n${lines}\n\n` +
          `Return JSON with exactly:\n` +
          `- "description": one sentence, <=140 characters\n` +
          `- "intro": 2-3 sentences, <=500 characters`,
      }], { maxTokens: 400 });

      const description = clean(json?.description, 140);
      const intro = clean(json?.intro, 500);
      if (description && intro) {
        const cost = (usage?.prompt_tokens ?? 0) * 0.15e-6 + (usage?.completion_tokens ?? 0) * 0.60e-6;
        result = { description, intro, source: 'llm', cost };
      }
    } catch {
      // LLM unavailable — fall through to the template
    }
  }

  if (!result) {
    const t = templateCopy(topic, events);
    result = { ...t, source: 'template', cost: 0 };
  }

  const stored = { description: result.description, intro: result.intro, source: result.source, cost: result.cost };
  // Only a real LLM result is worth caching — a template line produced because the
  // model was down must not be frozen in for the next run.
  if (result.source === 'llm') await cache?.set?.(hash, stored);
  return { ...stored, cached: false };
}

function clean(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function noun(topic) {
  if (topic.kind === 'time') return topic.free ? 'free things to do' : 'things to do';
  return 'events';
}

// ── Planning (pure) ──────────────────────────────────────────────────────────

/**
 * Build the full write plan for every topic: which events, in what order, and
 * whether the page clears the publish threshold. Pure and synchronous; the async
 * copy pass in runTopicPages fills description/intro before the write.
 * @returns {Array<{topic, slug, title, cover_image_url, published, items: string[], reason: string}>}
 */
export function planPages(topics, events, today) {
  return topics.map(topic => {
    const limit = PER_TOPIC[topic.kind] ?? PER_TOPIC.default;
    const picked = selectEvents(events, topic, today, limit);
    const published = picked.length >= MIN_EVENTS;
    const cover = picked.find(e => typeof e.image === 'string' && e.image && e.image !== 'null')?.image ?? null;
    const reason = published
      ? `published (${picked.length} events)`
      : `skipped: below min ${MIN_EVENTS} (${picked.length})`;
    return {
      topic,
      slug: topic.slug,
      title: topic.title,
      cover_image_url: cover,
      published,
      items: published ? picked.map(e => e.slug ?? e.id) : [],
      reason,
    };
  });
}

// ── Repository (the only place that writes) ──────────────────────────────────

/** Supabase-backed copy cache (list_copy_cache), so a re-run the next day reuses copy. */
export function createSupabaseCopyCache(supabase) {
  return {
    async get(hash) {
      const { data } = await supabase
        .from('list_copy_cache')
        .select('description, intro')
        .eq('content_hash', hash)
        .maybeSingle();
      return data ? { description: data.description, intro: data.intro } : null;
    },
    async set(hash, { description, intro }) {
      if (!description || !intro) return;
      const { error } = await supabase
        .from('list_copy_cache')
        .upsert({ content_hash: hash, description, intro, model: 'google/gemini-2.5-flash' }, { onConflict: 'content_hash' });
      if (error) logError('list_copy_cache upsert failed', error);
    },
  };
}

/** Default Supabase-backed repo. */
export function createSupabaseRepo(supabase, deps = {}) {
  const chat = deps.chatJSON;
  const cache = deps.cache ?? createSupabaseCopyCache(supabase);
  return {
    async upsertList(row) {
      const { data, error } = await supabase
        .from('curated_lists')
        .upsert(row, { onConflict: 'slug' })
        .select('id')
        .single();
      if (error) throw new Error(`curated_lists upsert failed: ${error.message}`);
      return { id: data.id };
    },
    async replaceItems(listId, positions) {
      const { error: delErr } = await supabase.from('list_items').delete().eq('list_id', listId);
      if (delErr) throw new Error(`list_items delete failed: ${delErr.message}`);
      if (positions.length === 0) return;
      const rows = positions.map(([eventId, position]) => ({ list_id: listId, event_id: eventId, position }));
      const { error: insErr } = await supabase.from('list_items').insert(rows);
      if (insErr) throw new Error(`list_items insert failed: ${insErr.message}`);
    },
    generateCopy,
    _deps: { chat, cache },
  };
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Full generation run. Reads events, plans every topic, writes idempotently,
 * returns a summary the caller can log.
 *
 * @param {object} [opts]
 * @param {object} [opts.supabase]  Supabase client (defaults to lib/supabase.js)
 * @param {object} [opts.repo]      repository to write through (for tests)
 * @param {Function} [opts.chatJSON] OpenRouter helper (defaults to lib/openrouter.js)
 * @param {Date}   [opts.now]       clock, for tests
 * @param {Array}  [opts.topics]    topic list override, for tests
 * @returns {Promise<{published:number, skipped:number, llmCalls:number, cost:number, pages:Array}>}
 */
export async function runTopicPages(opts = {}) {
  const today = nycYmd(opts.now ?? new Date());
  const topics = opts.topics ?? TOPICS;

  let supabase = opts.supabase;
  let chatJSON = opts.chatJSON;
  if (!supabase) ({ supabase } = await import('./supabase.js'));
  if (!chatJSON && !opts.repo) ({ chatJSON } = await import('./openrouter.js'));

  const repo = opts.repo ?? createSupabaseRepo(supabase, { chatJSON });
  const events = await fetchUpcomingEvents(supabase, today);
  const byKey = new Map(events.map(e => [e.slug ?? e.id, e]));

  const pages = planPages(topics, events, today);
  const summary = { published: 0, skipped: 0, llmCalls: 0, cost: 0, pages: [] };

  for (const page of pages) {
    const picked = page.items.map(k => byKey.get(k)).filter(Boolean);
    let copy = { description: null, intro: null, source: 'template' };
    if (page.published) {
      copy = await repo.generateCopy(page.topic, picked, repo._deps ?? {});
      if (copy.source === 'llm' && !copy.cached) summary.llmCalls++;
      summary.cost += copy.cost ?? 0;
    }

    const row = {
      slug: page.slug,
      title: page.title,
      description: copy.description,
      cover_image_url: page.cover_image_url,
      curator_name: 'NO MORE FOMO',
      city: 'nyc',
      published: page.published,
    };

    const { id } = await repo.upsertList(row);
    await repo.replaceItems(id, page.items.map((eid, i) => [eid, i]));

    if (page.published) {
      summary.published++;
      log(`✅ ${page.slug}: ${page.reason}${copy.source === 'template' ? ' [template copy]' : ''}`);
    } else {
      summary.skipped++;
      log(`⏭️  ${page.slug}: ${page.reason}`);
    }
    summary.pages.push({ slug: page.slug, published: page.published, items: page.items.length, copy: copy.source, reason: page.reason });
  }

  log(`Topic pages: ${summary.published} published, ${summary.skipped} skipped, ${summary.llmCalls} LLM calls (~$${summary.cost.toFixed(4)})`);
  return summary;
}
