# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NYC Events Crawler — a Node.js (ESM) multi-source pipeline that collects NYC events from several
sources (RSS feeds, WordPress calendars, and Playwright scrapes), optionally enriches them via an LLM,
and upserts them into Supabase (with optional AWS S3 / local JSON output). `index.js` is a runner that
dispatches to one crawler or a tier group.

Sources (`crawlers/`): `nyc-parks` (RSS), `rss-blogs` (neighborhood blog RSS + LLM extraction),
`riverside-park` (WordPress calendar), `westsiderag` (Playwright), `nyccom` (NYC.com multi-category
Playwright). **Tiers:** `all-tier1` = the non-Playwright crawlers (fast); `all-tier2` = the
Playwright-based crawlers (`westsiderag`, `nyccom`) — the heavy daily job that motivated the public-repo
migration (unlimited CI minutes).

> **Required secrets:** see `README.md` / `.env.example`. Secrets live in GitHub Actions Secrets, never
> in code. A pre-public secret scan is recorded in `SECURITY-AUDIT.md`.

## Commands

```bash
npm start                 # node index.js all-tier1  (the non-Playwright tier)
node index.js <crawler>   # run one crawler: nyc-parks | rss-blogs | riverside-park | westsiderag | nyccom
node index.js all-tier2   # Playwright tier (westsiderag, nyccom)
node index.js all         # every crawler
npm run upload            # Upload existing data files to S3 (requires AWS env vars)
```

Passing env vars inline:
```bash
TEST_MODE=true node index.js nyccom              # Limit nyccom to 10 events (fast dev run)
USE_LLM_EXTRACTION=true node index.js nyccom     # Use LLM instead of DOM extraction
ENABLE_ENRICHMENT=false node index.js nyccom     # Skip the LLM enrichment pipeline
STORAGE_MODE=s3 node index.js nyccom             # Also write results to S3
node upload-to-s3.js data/                       # Batch-upload all local JSON files
```

## Architecture

The `nyccom` crawler is the most complex source; its internals are documented below. The other crawlers
share `lib/base-crawler.js` helpers, normalize to the same event schema, and upsert via `lib/supabase.js`.

### 3-Phase Crawl (`crawlers/nyccom.js`)

1. **Category discovery** (`discoverCategories`) — visits 7 hardcoded main category URLs on nyc.com and scrapes subcategory links. Returns a flat list of category-page URLs.

2. **URL collection** (`collectAllEventUrls`) — for each category page, scrolls to load all items and extracts event detail URLs using regex patterns like `/events/[slug].\d+/`. Runs 2 categories concurrently.

3. **Extraction + enrichment** (`extractEventsInParallel`) — for each event URL, runs `extractEventDetails` then optionally `enrichEvent`. Runs 3 events concurrently. Each event is saved incrementally to disk immediately after extraction to avoid data loss on crash.

### Extraction Strategy

`extractEventDetails` runs one of two strategies:

- **Deterministic** (default, `USE_LLM_EXTRACTION=false`): `page.evaluate()` runs DOM queries and regex patterns inside the browser context. If the result is missing key fields (title, description, venue, time, or images), it falls back to LLM extraction for that event.
- **LLM-only** (`USE_LLM_EXTRACTION=true`): skips DOM extraction entirely and sends raw HTML to `gpt-4o-mini`.

### Enrichment Pipeline (`enrichEvent`)

Runs only when `OPENAI_API_KEY` is set and `ENABLE_ENRICHMENT != 'false'`. Three parallel OpenAI
(`gpt-4o-mini`) calls per event:
- `enrichWithWebResearch` — adds audience tags, highlights, reputation notes
- `enrichWithVenueIntelligence` — classifies venue type, capacity, historic status
- `enrichWithSmartCategories` — assigns 2–5 categories and "best for" tags

> **Planned migration (program items 02–04):** this 4-call OpenAI fan-out (1 extract + 3 enrich) is
> being replaced by a single structured **OpenRouter** (`google/gemini-2.5-flash`) call per cache-miss
> event, gated by a canonical-taxonomy normalizer (deterministic-first), a persistent `llm_cache`, and a
> per-day USD budget governor (~$5/mo cap). When that lands, the OpenAI SDK and these three functions are
> removed from the categorization path. Until then, the above describes the live code.

### Storage

- **Supabase** (primary): crawlers upsert normalized events via `lib/supabase.js` (requires
  `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`).
- **Local JSON** (`s3-storage.js`, default file output): writes to `data/events_<nyc-timestamp>.json`,
  accumulating events in the array on each save.
- **S3** (`STORAGE_MODE=s3`): also writes locally, then uploads the full file to
  `s3://<bucket>/events/<filename>` after each event save. Optional/legacy.

### Environment

`env-loader.js` is a minimal `.env` parser (no dotenv dependency). It does **not** override existing env vars — shell env takes precedence over `.env`. Copy `.env.example` to `.env` to configure locally.

### Event Schema

Each event object: `id` (SHA-256 of url+title, 16 hex chars), `source`, `sourceUrl`, `title`, `description`, `startDate`, `endDate`, `time`, `location{name,address,city,lat,lng}`, `price{min,max,currency,isFree}`, `categories[]`, `tags[]`, `organizer`, `attendance`, `ticketUrl`, `images[]`, `rawText`.

### Anti-Bot Measures

Browser runs with `headless: false` and a real Chrome user-agent. The `navigator.webdriver` property is masked via `addInitScript`. If a Cloudflare challenge is detected mid-crawl, the code waits an extra 5 s.
