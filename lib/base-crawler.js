import crypto from 'crypto';
import { supabase } from './supabase.js';
import { classifyEvent } from './enrichment.js';
import { fingerprint } from './dedup.js';
import { nonEventReason } from './event-filter.js';
import { normalizeCategory } from './taxonomy.js';
import { normalizeEventDates } from './nyc-time.js';
import { normalizeBorough } from './nyc-area.js';

// Per-run LLM budget state — reset by startCrawlRun, read by upsertEvent, flushed by finishCrawlRun
export const _runState = {
  llmBudgetExceeded: false,
  llmCalls: 0,
  llmCostUsd: 0,
  todaySpend: 0,
  dailyBudget: 0.15,
};

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
      llmResult = await classifyEvent(event);
      if (!llmResult.fromCache) {
        _runState.llmCalls++;
        _runState.llmCostUsd += llmResult.cost;
      }
      // Merge LLM canonical categories with deterministic ones
      if (llmResult.canonical_categories?.length > 0) {
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

/**
 * Upsert a batch of events. Returns { new, updated, deduped, uncategorized, errors }.
 */
export async function upsertEvents(events) {
  let newCount = 0, updatedCount = 0, dedupedCount = 0, uncategorizedCount = 0;
  const errors = [];

  for (const event of events) {
    const { status, uncategorized } = await upsertEvent(event);
    if (status === 'new') newCount++;
    else if (status === 'updated') updatedCount++;
    else if (status === 'duplicate') dedupedCount++;
    else errors.push(`Failed to upsert: ${event.title}`);
    if (uncategorized) uncategorizedCount++;
  }

  return { new: newCount, updated: updatedCount, deduped: dedupedCount, uncategorized: uncategorizedCount, errors };
}
