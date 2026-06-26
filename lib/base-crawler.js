import crypto from 'crypto';
import { supabase } from './supabase.js';
import { classifyEvent } from './enrichment.js';
import { fingerprint } from './dedup.js';
import { normalizeCategory } from './taxonomy.js';

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
  const { data: todayRuns } = await supabase
    .from('crawl_runs')
    .select('llm_cost_usd')
    .gte('created_at', todayStart.toISOString());

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

/**
 * Upsert a single event.
 * @returns {{ status: 'new'|'updated'|'duplicate'|'error', uncategorized: boolean }}
 */
export async function upsertEvent(event) {
  const fp = fingerprint(
    event.title,
    event.startDate ?? null,
    event.location?.name ?? null,
  );

  // Dedup check: if a different-id row shares the same content fingerprint, keep the richer one.
  const { data: dupRow } = await supabase
    .from('events')
    .select('id, description, images, categories')
    .eq('fingerprint', fp)
    .neq('id', event.id)
    .maybeSingle();

  if (dupRow) {
    const existingRichness = (dupRow.description?.length ?? 0) + (dupRow.images?.length ?? 0) * 10 + (dupRow.categories?.length ?? 0);
    const incomingRichness = (event.description?.length ?? 0) + (event.images?.length ?? 0) * 10 + (event.categories?.length ?? 0);
    if (existingRichness >= incomingRichness) {
      // Existing row is richer or equal — touch crawled_at, skip full upsert
      await supabase.from('events').update({ crawled_at: new Date().toISOString() }).eq('id', dupRow.id);
      return { status: 'duplicate', uncategorized: false };
    }
    // Incoming is richer — continue to upsert but link via same fingerprint
  }

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

  // quality_score: demote film events that lack a distinct start_date
  const qualityScore = (primary === 'film' && !event.startDate) ? -5 : 0;

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
    start_date:           event.startDate         ?? null,
    end_date:             event.endDate           ?? null,
    time:                 event.time              ?? null,
    category:             event.categories?.[0]   ?? null,
    categories:           event.categories        ?? [],
    tags:                 eventTags,
    canonical_category:   primary,
    canonical_categories: canonical,
    is_family:            isFamily,
    quality_score:        qualityScore,
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
    borough:              event.borough           ?? null,
    fingerprint:          fp,
    crawled_at:           new Date().toISOString(),
  };

  // Check if exists first so we can report new vs updated
  const { data: existing } = await supabase
    .from('events')
    .select('id')
    .eq('id', event.id)
    .maybeSingle();

  const { error } = await supabase
    .from('events')
    .upsert(row, { onConflict: 'id' });

  if (error) {
    logError(`Upsert failed for "${event.title}"`, error);
    return { status: 'error', uncategorized: false };
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
