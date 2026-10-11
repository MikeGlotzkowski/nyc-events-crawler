-- 004_recurrence.sql — one recurrence model for event rows (B2)
--
-- A recurring event is stored as one row per occurrence (the crawler expands
-- RRULEs / "every X" cadences). These two columns carry the shared series
-- identity so the app can group and page a series without re-deriving it from
-- titles:
--   series_id  — stable id shared by every occurrence of one series (16 hex)
--   occurrence — 0-based index of this row within its series
--
-- Nullable and additive: one-off events (the majority) leave both null, and the
-- crawler only writes them when it knows a series. Safe to run on the hosted DB.

alter table public.events add column if not exists series_id  text;
alter table public.events add column if not exists occurrence integer;

-- Filtering/grouping a series is the hot path (a feed that caps a long series).
create index if not exists events_series_id_idx
  on public.events (series_id)
  where series_id is not null;

comment on column public.events.series_id is
  'stable id shared by every occurrence (row) of one recurring series; null for one-off events';
comment on column public.events.occurrence is
  '0-based index of this row within its series_id (null for one-off events)';
