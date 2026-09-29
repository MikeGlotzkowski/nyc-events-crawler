-- One-off backfill for events the crawler wrote before it set start_at / slug / published.
-- Run once on prod (Supabase SQL editor). Idempotent: only touches rows still NULL.
--
-- 1. start_at: same convention as fomo3 0044_start_at.sql (date-only → midnight UTC of start_date).
--    The next crawl rewrites start_date/start_at/time with the correct NYC values for every
--    event still in its source feed (same id → upsert), so this only needs to make existing
--    rows visible in the feed until then.
-- 2. slug + published: same slug expression as fomo3 0021_public_slugs.sql; mirrors the crawler
--    rule "an event is published when it first gets a slug". Rows that already have a slug
--    (and their published flag) are left alone.

begin;

update public.events
set start_at = start_date::timestamptz
where start_at is null
  and start_date is not null;

update public.events
set slug = lower(regexp_replace(coalesce(title, 'event'), '[^a-zA-Z0-9]+', '-', 'g'))
           || '-' || left(id, 8),
    published = true
where slug is null;

commit;

-- Check:
-- select count(*) filter (where start_at is null and start_date is not null) as missing_start_at,
--        count(*) filter (where slug is null) as missing_slug
-- from public.events;
