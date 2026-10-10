-- Copy cache for the daily topic-pages generator (lib/topic-pages.js).
--
-- A page's description/intro depends only on the topic and its ordered events, so
-- key the copy by a hash of exactly that. When a topic's best events have not
-- changed since the last run, the stored copy is reused and no LLM call is made.
-- Only successful LLM output is stored, so a template fallback (LLM unavailable)
-- is never frozen in place. Service-role only — no RLS, like fomo3's llm_cache.

create table if not exists list_copy_cache (
  content_hash text        primary key,
  description  text,
  intro        text,
  model        text        not null default 'google/gemini-2.5-flash',
  created_at   timestamptz not null default now()
);
