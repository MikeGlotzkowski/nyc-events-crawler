-- Event Pipeline Schema Migration
-- Run this in your Supabase SQL editor

-- ============================================================
-- events table additions
-- ============================================================

ALTER TABLE events ADD COLUMN IF NOT EXISTS source       TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS neighborhood TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS borough      TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS crawled_at   TIMESTAMPTZ DEFAULT NOW();

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS events_start_date_idx  ON events (start_date);
CREATE INDEX IF NOT EXISTS events_source_idx      ON events (source);
CREATE INDEX IF NOT EXISTS events_neighborhood_idx ON events (neighborhood);

-- ============================================================
-- crawl_runs: one row per crawler execution
-- ============================================================

CREATE TABLE IF NOT EXISTS crawl_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name     TEXT        NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  events_found    INTEGER     NOT NULL DEFAULT 0,
  events_new      INTEGER     NOT NULL DEFAULT 0,
  events_updated  INTEGER     NOT NULL DEFAULT 0,
  error_count     INTEGER     NOT NULL DEFAULT 0,
  error_messages  JSONB       NOT NULL DEFAULT '[]',
  status          TEXT        NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'error', 'partial'))
);

CREATE INDEX IF NOT EXISTS crawl_runs_source_idx     ON crawl_runs (source_name);
CREATE INDEX IF NOT EXISTS crawl_runs_started_at_idx ON crawl_runs (started_at DESC);

-- ============================================================
-- crawler_config: one row per source, editable from admin UI
-- ============================================================

CREATE TABLE IF NOT EXISTS crawler_config (
  source_name       TEXT PRIMARY KEY,
  enabled           BOOLEAN     NOT NULL DEFAULT true,
  cron_expression   TEXT        NOT NULL DEFAULT '0 8 * * *',
  tier              INTEGER     NOT NULL DEFAULT 1,
  last_success_at   TIMESTAMPTZ,
  notes             TEXT
);

INSERT INTO crawler_config (source_name, cron_expression, tier, notes) VALUES
  ('nyc-parks',      '0 6 * * *',     1, 'NYC Parks RSS — ~1200 structured events daily'),
  ('riverside-park', '0 7 * * *',     1, 'Riverside Park Events Calendar API (WordPress)'),
  ('rss-blogs',      '0 */6 * * *',   1, 'All neighborhood RSS feeds with LLM extraction'),
  ('westsiderag',    '0 9 * * 1',     2, 'West Side Rag weekly events — Playwright, Mondays'),
  ('nyccom',         '0 3 * * *',     2, 'NYC.com Playwright crawler — full site scrape')
ON CONFLICT (source_name) DO NOTHING;

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE crawl_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE crawler_config ENABLE ROW LEVEL SECURITY;

-- Service role (crawlers) can do everything
CREATE POLICY "service_role_all_crawl_runs"     ON crawl_runs     FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_crawler_config" ON crawler_config FOR ALL USING (auth.role() = 'service_role');

-- Anon/authenticated can read (needed for admin UI using anon key)
CREATE POLICY "anon_read_crawl_runs"     ON crawl_runs     FOR SELECT USING (true);
CREATE POLICY "anon_read_crawler_config" ON crawler_config FOR SELECT USING (true);

-- ============================================================
-- Nightly cleanup: delete events older than 1 day
-- (requires pg_cron extension — enable in Supabase dashboard first)
-- ============================================================

-- SELECT cron.schedule(
--   'delete-past-events',
--   '0 2 * * *',
--   $$DELETE FROM events WHERE start_date < NOW() - INTERVAL '1 day'$$
-- );
