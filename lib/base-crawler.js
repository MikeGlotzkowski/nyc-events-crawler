import crypto from 'crypto';
import { supabase } from './supabase.js';
import { enrichWithVibeTags } from './enrichment.js';

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
  const { eventsFound = 0, eventsNew = 0, eventsUpdated = 0, errors = [] } = stats;
  const status = errors.length > 0 && eventsFound === 0 ? 'error'
               : errors.length > 0 ? 'partial'
               : 'success';

  await supabase.from('crawl_runs').update({
    finished_at: new Date().toISOString(),
    events_found: eventsFound,
    events_new: eventsNew,
    events_updated: eventsUpdated,
    error_count: errors.length,
    error_messages: errors,
    status,
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
 * Upsert a single event. Returns 'new' | 'updated' | 'error'.
 */
export async function upsertEvent(event) {
  if (process.env.ENABLE_ENRICHMENT === 'true') {
    event = await enrichWithVibeTags(event);
  }

  const row = {
    id:                event.id,
    title:             event.title || 'Untitled Event',
    description:       event.description       ?? null,
    short_description: shortDesc(event.description),
    start_date:        event.startDate         ?? null,
    end_date:          event.endDate           ?? null,
    time:              event.time              ?? null,
    category:          event.categories?.[0]   ?? null,
    categories:        event.categories        ?? [],
    tags:              event.tags              ?? [],
    image:             event.images?.[0]        ?? null,
    images:            event.images            ?? [],
    price_min:         event.price?.min        ?? null,
    price_max:         event.price?.max        ?? null,
    price_currency:    event.price?.currency   ?? 'USD',
    is_free:           event.price?.isFree     ?? false,
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
    organizer:         event.organizer                                  ?? null,
    attendance:        event.attendance != null ? String(event.attendance) : null,
    ticket_url:        event.ticketUrl         ?? null,
    source:            event.source            ?? null,
    source_url:        event.sourceUrl         ?? null,
    highlights:        [],
    reputation:        null,
    raw_data:          event,
    neighborhood:      event.neighborhood      ?? null,
    borough:           event.borough           ?? null,
    crawled_at:        new Date().toISOString(),
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
    return 'error';
  }
  return existing ? 'updated' : 'new';
}

/**
 * Upsert a batch of events. Returns { new, updated, errors }.
 */
export async function upsertEvents(events) {
  let newCount = 0, updatedCount = 0;
  const errors = [];

  for (const event of events) {
    const result = await upsertEvent(event);
    if (result === 'new') newCount++;
    else if (result === 'updated') updatedCount++;
    else errors.push(`Failed to upsert: ${event.title}`);
  }

  return { new: newCount, updated: updatedCount, errors };
}
