-- 002_canonical_events.sql — canonical cross-source identity (B1)
--
-- Links rows that are the same real-world event across sources. The richest
-- row of a group keeps a null hidden_reason (visible) and stores the group in
-- canonical_event_id + dup_sources; every other member gets
-- hidden_reason='duplicate' (the existing hide mechanism from 0049) and points
-- back at the canonical row.
--
-- Reuses public.events.hidden_reason ('duplicate') — no new hide mechanism.

alter table public.events add column if not exists canonical_event_id text;
alter table public.events add column if not exists dup_sources jsonb;

-- Find the members/duplicates of a canonical group quickly.
create index if not exists events_canonical_event_id_idx
  on public.events (canonical_event_id);

-- Visible rows, by day — the crawler's reconcile reads this slice.
create index if not exists events_start_date_visible_idx
  on public.events (start_date)
  where hidden_reason is null;

comment on column public.events.canonical_event_id is
  'id of the richest row for the same real-world event across sources (self for the canonical row, its id for duplicates)';
comment on column public.events.dup_sources is
  'jsonb array of {id, source} for every source folded into this canonical event';
