import crypto from 'crypto';
import { supabase } from './supabase.js';
import { classifyEvent } from './enrichment.js';
import { fingerprint } from './dedup.js';
import { cleanText, nonEventReason } from './event-filter.js';
import { normalizeCategory } from './taxonomy.js';
import { normalizeEventDates } from './nyc-time.js';
import { normalizeBorough } from './nyc-area.js';
import { groupCanonical, mergeCanonicalFields, calendarDate } from './canonical.js';
import { backfillImages } from './image-backfill.js';
import { mapPool } from './pool.js';

// How many events to upsert in flight. Ticketmaster (11k+ events) was strictly
// sequential (~1 event/sec → 2 Supabase round-trips each), so it could not finish
// inside the CI cap. Override with UPSERT_CONCURRENCY; clamped to a sane range.
const UPSERT_DEFAULT_CONCURRENCY = 8;

export function upsertConcurrency() {
  const raw = Number(process.env.UPSERT_CONCURRENCY);
  const n = Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : UPSERT_DEFAULT_CONCURRENCY;
  return Math.min(Math.max(n, 1), 32);
}

// Per-run LLM budget state — reset by startCrawlRun, read by upsertEvent, flushed by finishCrawlRun
export const _runState = {
  llmBudgetExceeded: false,
  llmCalls: 0,
  llmCostUsd: 0,
  todaySpend: 0,
  dailyBudget: 0.15,
};

// Serialises the LLM enrichment path. With the batch upsert running events
// concurrently, the budget check-then-spend must be atomic or N in-flight events
// all pass the check at spend 0.29 and blow the daily cap. The enrichment call is
// I/O-bound and cached, so serialising it costs almost nothing while the DB
// upserts stay 8-wide.
let _llmQueue = Promise.resolve();
function runLlmExclusive(fn) {
  const run = _llmQueue.then(fn, fn);
  _llmQueue = run.then(() => {}, () => {});
  return run;
}

/** The content-dedup fingerprint of an event, exactly as upsertEvent derives it. */
function eventFingerprintKey(event) {
  const dates = normalizeEventDates(event.startDate ?? null, event.time ?? null, event.endDate ?? null);
  return fingerprint(cleanText(event.title) || event.title, dates.startDate, event.location?.name ?? null);
}

export function generateEventId(url, title) {
  return crypto.createHash('sha256').update(`${url}-${title}`).digest('hex').substring(0, 16);
}

export function log(msg, ...args) {
  console.log(`[${new Date().toISOString()}] ${msg}`, ...args);
}

export function logError(msg, err) {
  console.error(`[${new Date().toISOString()}] ❌ ${msg}`, err?.message || err);
}

// ── Config row helpers ─────────────────────────────────────────

/**
 * Ensures a crawler_config row exists for sourceName (no-op if already present).
 * Returns true if the source is enabled, false if disabled.
 */
export async function ensureConfigAndCheckEnabled(sourceName) {
  // Insert default row if absent (enabled=true by default)
  await supabase
    .from('crawler_config')
    .upsert(
      { source_name: sourceName, enabled: true },
      { onConflict: 'source_name', ignoreDuplicates: true }
    );

  const { data } = await supabase
    .from('crawler_config')
    .select('enabled')
    .eq('source_name', sourceName)
    .maybeSingle();

  return data?.enabled !== false; // absent row defaults to enabled
}

// Runs that have started but not yet finished, keyed by source. Used by the CLI
// entry point to stamp a terminal state when the process is killed (CI cancel).
const _activeRuns = new Map();

// ── Crawl run lifecycle ────────────────────────────────────────

export async function startCrawlRun(sourceName) {
  // Read daily budget from config (per-source, default 0.15)
  const { data: configRow } = await supabase
    .from('crawler_config')
    .select('llm_daily_budget_usd')
    .eq('source_name', sourceName)
    .maybeSingle();

  const dailyBudget = configRow?.llm_daily_budget_usd ?? 0.15;

  // Sum today's LLM spend across all crawl_runs
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { data: todayRuns, error: spendError } = await supabase
    .from('crawl_runs')
    .select('llm_cost_usd')
    .gte('started_at', todayStart.toISOString());
  if (spendError) logError('Failed to read today\'s LLM spend', spendError);

  const todaySpend = (todayRuns ?? []).reduce((sum, r) => sum + Number(r.llm_cost_usd ?? 0), 0);

  // Reset run state
  _runState.dailyBudget = dailyBudget;
  _runState.todaySpend = todaySpend;
  _runState.llmBudgetExceeded = todaySpend >= dailyBudget;
  _runState.llmCalls = 0;
  _runState.llmCostUsd = 0;

  const { data, error } = await supabase
    .from('crawl_runs')
    .insert({ source_name: sourceName, status: 'running' })
    .select('id')
    .single();

  if (error) {
    logError('Failed to create crawl_run', error);
    return null;
  }
  _activeRuns.set(sourceName, data.id);
  return data.id;
}

export async function finishCrawlRun(runId, stats) {
  if (!runId) return;
  const { eventsFound = 0, eventsNew = 0, eventsUpdated = 0, eventsDeduped = 0, eventsUncategorized = 0, errors = [] } = stats;
  const status = errors.length > 0 && eventsFound === 0 ? 'error'
               : errors.length > 0 ? 'partial'
               : 'success';

  await supabase.from('crawl_runs').update({
    finished_at: new Date().toISOString(),
    events_found: eventsFound,
    events_new: eventsNew,
    events_updated: eventsUpdated,
    events_deduped: eventsDeduped,
    events_uncategorized: eventsUncategorized,
    error_count: errors.length,
    error_messages: errors,
    status,
    llm_calls: _runState.llmCalls,
    llm_cost_usd: _runState.llmCostUsd,
    llm_budget_exceeded: _runState.llmBudgetExceeded,
  }).eq('id', runId);

  if (status !== 'error') {
    await supabase
      .from('crawler_config')
      .update({ last_success_at: new Date().toISOString() })
      .eq('source_name', stats.sourceName);
  }
  for (const [name, id] of _activeRuns) if (id === runId) _activeRuns.delete(name);
}

/**
 * Best-effort terminal state for a run that died before finishing (e.g. the CI
 * runner cancelled the job). Without this the row keeps finished_at = null and
 * the next review cannot tell 'crashed' from 'still running'.
 *
 * Supabase has no unique constraint on finished_at, so a normal finishCrawlRun
 * that races this call simply overwrites it with the real stats.
 */
export async function failCrawlRun(runId, message) {
  if (!runId) return;
  try {
    await supabase.from('crawl_runs').update({
      finished_at: new Date().toISOString(),
      status: 'error',
      error_count: 1,
      error_messages: [message],
      llm_calls: _runState.llmCalls,
      llm_cost_usd: _runState.llmCostUsd,
      llm_budget_exceeded: _runState.llmBudgetExceeded,
    }).eq('id', runId);
  } catch (err) {
    logError('failCrawlRun failed', err);
  }
}

/**
 * Stamp every run that is currently in flight as aborted. Called from the CLI
 * signal handler (SIGTERM/SIGINT) so a cancelled CI job records a terminal state.
 */
export async function abortActiveCrawlRuns(reason) {
  const ids = [..._activeRuns.values()];
  await Promise.all(ids.map((id) => failCrawlRun(id, reason)));
  _activeRuns.clear();
}

// ── Event upsert ──────────────────────────────────────────────

function shortDesc(description) {
  if (!description || description.length <= 150) return description ?? '';
  const match = description.match(/[^.!?]+[.!?]+/);
  if (match && match[0].length <= 200) return match[0].trim();
  return description.substring(0, 147) + '...';
}

/** Same slug as the 0021_public_slugs backfill in the app repo. */
export function eventSlug(title, id) {
  return (title ?? 'event').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() + '-' + id.slice(0, 8);
}

/**
 * Upsert a single event.
 * @returns {{ status: 'new'|'updated'|'duplicate'|'error', uncategorized: boolean }}
 */
export async function upsertEvent(event) {
  event = {
    ...event,
    title: cleanText(event.title) || event.title,
    description: event.description == null ? event.description : cleanText(event.description),
  };
  const dates = normalizeEventDates(event.startDate ?? null, event.time ?? null, event.endDate ?? null);

  const fp = fingerprint(
    event.title,
    dates.startDate,
    event.location?.name ?? null,
  );

  // Dedup check: if visible different-id rows share the same content fingerprint, keep the richer one.
  const { data: dupRows } = await supabase
    .from('events')
    .select('id, description, images, categories')
    .eq('fingerprint', fp)
    .neq('id', event.id)
    .is('hidden_reason', null);

  const richness = (e) => (e.description?.length ?? 0) + (e.images?.length ?? 0) * 10 + (e.categories?.length ?? 0);
  const dups = dupRows ?? [];
  if (dups.length > 0) {
    const best = dups.reduce((a, b) => (richness(b) > richness(a) ? b : a));
    if (richness(best) >= richness(event)) {
      // Existing row is richer or equal — touch crawled_at, skip full upsert
      await supabase.from('events').update({ crawled_at: new Date().toISOString() }).eq('id', best.id);
      return { status: 'duplicate', uncategorized: false };
    }
    // Incoming is richer — upsert it below, then hide the rows it replaces
  }

  // Not an event (poll, cancelled, volunteer shift, ...): store it hidden, never shown in the app
  const hiddenReason = nonEventReason(event);

  // Canonical taxonomy normalization
  let { canonical, primary, isFamily, unmatched } = normalizeCategory(
    event.categories ?? [],
    event.title ?? '',
    event.tags ?? [],
  );

  // LLM enrichment — only on unmatched events with budget remaining
  let llmResult = null;
  // Re-check budget mid-run: accumulated run spend may have crossed the threshold
  if (_runState.todaySpend + _runState.llmCostUsd >= _runState.dailyBudget) {
    _runState.llmBudgetExceeded = true;
  }
  if (
    unmatched.length > 0 &&
    !hiddenReason &&
    process.env.ENABLE_ENRICHMENT !== 'false' &&
    !_runState.llmBudgetExceeded
  ) {
    try {
      llmResult = await runLlmExclusive(async () => {
        // Re-check inside the lane: concurrent events may have spent the budget
        // while this event waited its turn.
        if (_runState.todaySpend + _runState.llmCostUsd >= _runState.dailyBudget) {
          _runState.llmBudgetExceeded = true;
          return null;
        }
        const res = await classifyEvent(event);
        if (!res.fromCache) {
          _runState.llmCalls++;
          _runState.llmCostUsd += res.cost;
        }
        return res;
      });
      // Merge LLM canonical categories with deterministic ones
      if (llmResult?.canonical_categories?.length > 0) {
        const merged = new Set([...canonical, ...llmResult.canonical_categories]);
        canonical = Array.from(merged);
        primary = primary ?? llmResult.canonical_categories[0] ?? null;
        isFamily = isFamily || llmResult.is_family;
      }
    } catch {
      // Never block a crawl on LLM failure
    }
  }

  // quality_score is computed by a database trigger (fomo3 migration 0051), not here.

  const eventTags = event.tags ?? [];
  if (llmResult?.vibe_tags?.length > 0) {
    const existingSet = new Set(eventTags.map(t => t.toLowerCase()));
    for (const vt of llmResult.vibe_tags) {
      if (!existingSet.has(vt.toLowerCase())) eventTags.push(vt);
    }
  }

  const row = {
    id:                   event.id,
    title:                event.title || 'Untitled Event',
    description:          event.description       ?? null,
    short_description:    llmResult?.short_description ?? shortDesc(event.description),
    start_date:           dates.startDate,
    start_at:             dates.startAt,
    end_date:             dates.endDate,
    time:                 dates.time,
    category:             event.categories?.[0]   ?? null,
    categories:           event.categories        ?? [],
    tags:                 eventTags,
    canonical_category:   primary,
    canonical_categories: canonical,
    is_family:            isFamily,
    image:                event.images?.[0]        ?? null,
    images:               event.images            ?? [],
    price_min:            event.price?.min        ?? null,
    price_max:            event.price?.max        ?? null,
    price_currency:       event.price?.currency   ?? 'USD',
    is_free:              event.price?.isFree     ?? false,
    venue: event.location ? {
      name:        event.location.name        ?? null,
      address:     event.location.address     ?? null,
      city:        event.location.city        ?? 'New York',
      description: event.location.description ?? null,
    } : null,
    location: event.location?.lat != null ? {
      lat: event.location.lat,
      lng: event.location.lng,
    } : null,
    organizer:            event.organizer                                  ?? null,
    attendance:           event.attendance != null ? String(event.attendance) : null,
    ticket_url:           event.ticketUrl         ?? null,
    source:               event.source            ?? null,
    source_url:           event.sourceUrl         ?? null,
    highlights:           [],
    reputation:           null,
    raw_data:             event,
    neighborhood:         event.neighborhood      ?? null,
    borough:              normalizeBorough(event.borough),
    fingerprint:          fp,
    crawled_at:           new Date().toISOString(),
  };

  // No image this crawl (fetch failed, page changed) must not wipe one saved earlier or backfilled.
  if (row.images.length === 0) {
    delete row.image;
    delete row.images;
  }

  // Check if exists first so we can report new vs updated
  const { data: existing } = await supabase
    .from('events')
    .select('id, slug')
    .eq('id', event.id)
    .maybeSingle();

  // Give an event its public page once. Re-crawls never touch an existing slug
  // (links/sitemap) or published (manual unpublish sticks).
  if (!existing?.slug) {
    row.slug = eventSlug(row.title, row.id);
    row.published = true;
  }

  // Only ever set hidden_reason, so a re-crawl never un-hides a row — except
  // when this row wins a dedup and replaces the visible duplicates.
  if (hiddenReason) row.hidden_reason = `non_event:${hiddenReason}`;
  else if (dups.length > 0) row.hidden_reason = null;

  const { error } = await supabase
    .from('events')
    .upsert(row, { onConflict: 'id' });

  if (error) {
    logError(`Upsert failed for "${event.title}"`, error);
    return { status: 'error', uncategorized: false };
  }
  if (dups.length > 0 && !hiddenReason) {
    await supabase.from('events').update({ hidden_reason: 'duplicate' }).in('id', dups.map(d => d.id));
  }
  return { status: existing ? 'updated' : 'new', uncategorized: unmatched.length > 0 };
}

// ── Cross-source canonical reconcile ──────────────────────────

const RECONCILE_COLS = 'id, source, title, description, images, categories, tags, '
  + 'price_min, price_max, ticket_url, source_url, start_date, time, venue, location, canonical_event_id, hidden_reason';

/** DB row → the event shape canonical.js groups on. */
function dbRowToEvent(r) {
  return {
    id:          r.id,
    source:      r.source,
    title:       r.title,
    description: r.description,
    images:      r.images ?? [],
    categories:  r.categories ?? [],
    tags:        r.tags ?? [],
    startDate:   r.start_date ?? null,
    time:        r.time ?? null,
    location: {
      name: r.venue?.name ?? null,
      lat:  r.location?.lat ?? null,
      lng:  r.location?.lng ?? null,
    },
    price:     { min: r.price_min ?? null, max: r.price_max ?? null },
    ticketUrl: r.ticket_url ?? null,
    sourceUrl: r.source_url ?? null,
  };
}

/**
 * Group cross-source duplicates among the just-crawled rows and persist the linkage:
 * the richest row keeps `canonical_event_id` + merged fields and stays visible; every
 * other member gets `hidden_reason='duplicate'`. Rows from the same source, non-event
 * rows and rows whose dates differ are never merged. Never throws — a failed reconcile
 * must not fail the crawl.
 *
 * @param {Array<object>} events  the batch that was just upserted (crawler shape)
 * @returns {Promise<{groups:number, linked:number, hidden:number}>}
 */
export async function reconcileCanonical(events = []) {
  const dates = [...new Set(events.map(calendarDate).filter(Boolean))];
  if (dates.length === 0) return { groups: 0, linked: 0, hidden: 0 };

  const { data, error } = await supabase
    .from('events')
    .select(RECONCILE_COLS)
    .in('start_date', dates)
    .is('hidden_reason', null);
  if (error) {
    logError('Canonical reconcile query failed', error);
    return { groups: 0, linked: 0, hidden: 0 };
  }

  const rows = (data ?? [])
    .filter((r) => r.source && !String(r.id).startsWith('non_event'))
    .map(dbRowToEvent);

  let linked = 0, hidden = 0;
  for (const group of groupCanonical(rows)) {
    const merged = mergeCanonicalFields(group.canonical, group.duplicates);
    const winnerFields = {
      canonical_event_id: group.canonical.id,
      dup_sources:        merged.dup_sources,
      hidden_reason:      null,
      description:        merged.description,
      ticket_url:         merged.ticket_url,
    };
    if (merged.location) winnerFields.location = merged.location;
    if (merged.images.length > 0) { winnerFields.images = merged.images; winnerFields.image = merged.image; }
    if (merged.price) { winnerFields.price_min = merged.price.min; winnerFields.price_max = merged.price.max; }

    await supabase.from('events').update(winnerFields).eq('id', group.canonical.id);
    linked++;

    const loserIds = group.duplicates.map((d) => d.id);
    if (loserIds.length > 0) {
      await supabase.from('events').update({
        hidden_reason:      'duplicate',
        canonical_event_id: group.canonical.id,
        dup_sources:        merged.dup_sources,
      }).in('id', loserIds);
      hidden += loserIds.length;
    }
  }
  return { groups: linked, linked, hidden };
}

/**
 * Upsert a batch of events. Returns { new, updated, deduped, uncategorized, errors }.
 *
 * Before writing, events with no image but a sourceUrl are offered to the shared image
 * backfill (B6): the page is fetched once, its og:image/JSON-LD image filled in. This is
 * best-effort and never blocks or fails the crawl. Disable with ENABLE_IMAGE_BACKFILL=false
 * or per call via `opts.imageBackfill = false`.
 */
export async function upsertEvents(events, opts = {}) {
  if (events.length > 0 && opts.imageBackfill !== false && process.env.ENABLE_IMAGE_BACKFILL !== 'false') {
    try {
      const img = await backfillImages(events, opts.imageBackfill || undefined);
      if (img.candidates > 0) {
        log(`[images] backfill: ${img.filled}/${img.candidates} filled (fetched ${img.fetched}${img.capped ? `, capped at ${img.fetched}` : ''})`);
      }
    } catch (err) {
      logError('Image backfill failed', err);
    }
  }

  let newCount = 0, updatedCount = 0, dedupedCount = 0, uncategorizedCount = 0;
  const errors = [];

  const runOne = async (event) => {
    const { status, uncategorized } = await upsertEvent(event);
    if (status === 'new') newCount++;
    else if (status === 'updated') updatedCount++;
    else if (status === 'duplicate') dedupedCount++;
    else errors.push(`Failed to upsert: ${event.title}`);
    if (uncategorized) uncategorizedCount++;
  };

  // Fan the batch out over a bounded pool. Two events in one batch may share a
  // content fingerprint (the same show from two sources within one file); the
  // dedup reads the DB before writing, so running those concurrently could
  // double-insert. Give each repeated fingerprint its own serial lane, while
  // distinct fingerprints run in the pool.
  const keys = events.map(eventFingerprintKey);
  const lanes = new Map();
  for (const k of keys) lanes.set(k, (lanes.get(k) ?? 0) + 1);
  const chains = new Map();

  await mapPool(events, upsertConcurrency(), (event, i) => {
    if (lanes.get(keys[i]) <= 1) return runOne(event);
    const chain = chains.get(keys[i]) ?? Promise.resolve();
    const next = chain.then(() => runOne(event), () => runOne(event));
    chains.set(keys[i], next.then(() => {}, () => {}));
    return next;
  });

  if (events.length > 0) {
    try {
      await reconcileCanonical(events);
    } catch (err) {
      logError('Canonical reconcile failed', err);
    }
  }

  return { new: newCount, updated: updatedCount, deduped: dedupedCount, uncategorized: uncategorizedCount, errors };
}
