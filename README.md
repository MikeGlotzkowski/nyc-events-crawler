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

## Architecture

See [`CLAUDE.md`](CLAUDE.md) for crawler internals (the `nyccom` 3-phase crawl, extraction strategy,
enrichment pipeline, event schema, and anti-bot measures).
