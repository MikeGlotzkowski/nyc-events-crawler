# nyccom — NYC Events Crawler

A Node.js (ESM, Node 24) multi-source pipeline that collects NYC events from RSS feeds, WordPress
calendars, and Playwright scrapes, optionally enriches them with an LLM, and upserts them into Supabase
(with optional AWS S3 / local-JSON output). It feeds the [NO MORE FOMO](https://github.com/) event app.

## Sources

| Crawler | Source | Tier |
|---------|--------|------|
| `nyc-parks` | NYC Parks RSS feed | 1 (fast) |
| `rss-blogs` | 25 neighborhood blog RSS feeds + LLM extraction | 1 (fast) |
| `riverside-park` | Riverside Park WordPress events calendar | 1 (fast) |
| `whitney` | Whitney Museum events (JSON API) | 1 (fast) |
| `bam` | BAM calendar (JSON) | 1 (fast) |
| `lincoln-center` | Lincoln Center campus calendar, all resident organizations (JSON) | 1 (fast) |
| `carnegie-hall` | Carnegie Hall performances from its sitemap | 1 (fast) |
| `resident-advisor` | Resident Advisor NYC club nights, next 14 days (GraphQL) | 1 (fast) |
| `dice` | DICE New York shows, DJ nights and parties (browse pages) | 1 (fast) |
| `timeout` | Time Out New York's "things to do this weekend" list (LLM extraction) | 1 (fast) |
| `westsiderag` | West Side Rag weekly events page (Playwright) | 2 (Playwright) |
| `nyccom` | NYC.com multi-category crawl (Playwright) | 2 (Playwright) |

Tier 1 runs without a browser; Tier 2 uses Playwright and is the heavier daily job.

## Setup

```bash
npm install
npx playwright install chromium    # only needed for Tier-2 crawlers
cp .env.example .env               # then fill in the secrets below
```

## Required secrets

Set these as environment variables (locally in `.env`, in CI as **GitHub Actions Secrets**). Secrets are
never committed — `.env` is gitignored and a pre-public scan is recorded in
[`SECURITY-AUDIT.md`](SECURITY-AUDIT.md).

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_URL` | Yes | Supabase project URL (event upserts) |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service-role key — **full DB access, keep secret** |
| `OPENAI_API_KEY` | For `rss-blogs` LLM extraction + `nyccom` enrichment | OpenAI key (`gpt-4o-mini`). *Migrating to `OPENROUTER_API_KEY` in program items 02–04.* |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_S3_BUCKET` / `AWS_REGION` | Only when `STORAGE_MODE=s3` | Optional/legacy S3 output |

See [`.env.example`](.env.example) for the full set, including tuning flags (`TEST_MODE`,
`USE_LLM_EXTRACTION`, `ENABLE_ENRICHMENT`, `STORAGE_MODE`).

## Running

```bash
npm start                 # node index.js all-tier1  (non-Playwright tier)
node index.js <crawler>   # one crawler: nyc-parks | rss-blogs | riverside-park | westsiderag | nyccom
node index.js all-tier2   # Playwright tier (westsiderag, nyccom)
node index.js all         # every crawler
npm run upload            # batch-upload local JSON files to S3
```

Useful inline flags:

```bash
TEST_MODE=true node index.js nyccom            # limit nyccom to 10 events
ENABLE_ENRICHMENT=false node index.js nyccom   # skip the LLM enrichment pipeline
STORAGE_MODE=s3 node index.js nyccom           # also write results to S3
```

CI runs the crawlers on a schedule via `.github/workflows/crawl-tier1.yml` and `crawl-tier2.yml`.
`.github/workflows/source-health.yml` checks twice a day that every enabled source is still finding events and
keeps a "Crawler health alert" issue open while one isn't (`npm run health` prints the same report locally).

## Topic pages

`node index.js topic-pages` (or `npm run topic-pages`) refreshes the app's public collection pages
(`/lists/:slug`) from the upcoming events already in Supabase. It builds ~50 topics from the app's taxonomy
— time-intent (`tonight`, `this-weekend`, `free-tonight`, …), geo × category (`live-music-in-brooklyn`,
`comedy-in-manhattan`, …) and one hub per bucket — picks 8–15 deterministic events for each, writes a short
description + intro (LLM via `lib/openrouter.js`, cached by content hash, deterministic template fallback),
and upserts `curated_lists` by `slug` with its `list_items` replaced in place.

Index discipline: a topic publishes only with at least `MIN_EVENTS` qualifying events; one that falls below
that on a later run is written `published=false` (never deleted) so its URL does not 404. `.github/workflows/topic-pages.yml`
runs it daily at 07:30 UTC, after the tier-1 crawl.

## Architecture

See [`CLAUDE.md`](CLAUDE.md) for crawler internals (the `nyccom` 3-phase crawl, extraction strategy,
enrichment pipeline, event schema, and anti-bot measures).
