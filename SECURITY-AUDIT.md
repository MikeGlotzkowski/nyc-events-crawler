# Security Audit — Pre-Public Migration

**Date:** 2026-06-24
**Repo:** `nyccom` (NYC events crawler pipeline)
**Purpose:** Confirm git history and tracked files are free of secrets/PII before flipping the
repo to **public** (to unlock unlimited GitHub Actions minutes for the Tier-2 Playwright crawl).
**Result:** ✅ **CLEAN** — no secrets found in history or working tree.
**Publication strategy:** rather than rotate, the code ships to a **new public repo as a single fresh
snapshot with no git history** (`nyc-events-crawler`); the private repo and its history stay private. Since
no key was ever exposed publicly, key rotation is **not required** by this migration (see note below).

---

## Method

Scanned the **full git history** (18 commits) with two independent scanners plus manual checks.

| Check | Tool / command | Result |
|-------|----------------|--------|
| Secret scan (history + tree) | `gitleaks detect --no-banner -v` (v8.30.1) | **no leaks found** — 18 commits, ~380 KB scanned |
| Secret scan (history + tree) | `trufflehog git file://. --no-update --results=verified,unknown` (v3.95.6) | **0 verified, 0 unverified** — 150 chunks, ~387 KB |
| `.env` ever committed? | `git log --all --full-history -- '.env' '.env.local' '.env.production'` | **empty** — `.env` was never tracked |
| `.env` gitignored? | inspected `.gitignore` | ✅ `.env` (line 2) is ignored; only `.env.example` is tracked |
| Literal keys in tree | `grep -rInE "sk-or-\|sk-[A-Za-z0-9]{20}\|service_role\|eyJ[A-Za-z0-9_-]{10}\|AKIA[0-9A-Z]{16}" --exclude-dir=node_modules --exclude-dir=.git .` | only RLS role-name references (see below) — **no secrets** |

### Command outputs (verbatim)

```
$ gitleaks detect --no-banner -v
INF 18 commits scanned.
INF scanned ~380221 bytes (380.22 KB) in 90.5ms
INF no leaks found

$ trufflehog git file://. --no-update --results=verified,unknown
finished scanning  {"chunks": 150, "bytes": 386630, "verified_secrets": 0, "unverified_secrets": 0}

$ git log --all --full-history -- '.env' '.env.local' '.env.production'
(no output — never tracked)
```

### Literal-key grep — the only hits, explained

```
supabase/001_event_pipeline.sql:68:CREATE POLICY "service_role_all_crawl_runs"     ... USING (auth.role() = 'service_role');
supabase/001_event_pipeline.sql:69:CREATE POLICY "service_role_all_crawler_config" ... USING (auth.role() = 'service_role');
```

These are **not secrets** — `service_role` is the Postgres/Supabase RLS *role name* referenced in
row-level-security policy definitions. No key material.

---

## Secrets used by this repo (for rotation reference)

Sourced from `.github/workflows/*.yml` (`crawl-tier1.yml`, `crawl-tier2.yml`) and `.env.example`.
All are read from environment only (`env-loader.js`, `lib/supabase.js`, `s3-storage.js`); none are
hard-coded.

| Secret | Where used | Rotate before public? |
|--------|-----------|-----------------------|
| `SUPABASE_SERVICE_KEY` | Supabase writes (all crawlers) | **Yes** — grants full DB access |
| `OPENAI_API_KEY` | LLM extraction + enrichment (`gpt-4o-mini`) | **Yes** — billable API key |
| `SUPABASE_URL` | Supabase endpoint | No (not a secret; project URL) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | optional S3 upload (`STORAGE_MODE=s3`) | Only if S3 is in use |

> **Note on plan vs. reality:** the plan/spec name `OPENROUTER_API_KEY` for rotation, but this repo
> currently uses **OpenAI** (`OPENAI_API_KEY`) — OpenRouter is future work (program items 02–04).
> The key that actually exists and must be rotated is `OPENAI_API_KEY`.

---

## Key rotation — not required by this migration

The chosen publication strategy means **no secret ever becomes world-readable**: only a single fresh
snapshot of the current (clean) tree is published, and the history-bearing private repo stays private.
The scans found nothing regardless. Therefore key rotation is **optional hygiene**, not a precondition.

If you later choose to rotate anyway (good practice on any schedule):

- [ ] Rotate **`SUPABASE_SERVICE_KEY`** (Supabase dashboard → Project Settings → API → roll service_role key).
- [ ] Rotate **`OPENAI_API_KEY`** (OpenAI dashboard → revoke old key, create new).
- [ ] Update **GitHub Actions Secrets** on both repos and local **`.env`**.

## Public-repo bring-up checklist

- [ ] New public repo `nyc-events-crawler` created; fresh snapshot pushed (no history).
- [ ] Add Actions Secrets on the new repo: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `OPENAI_API_KEY`
      (+ AWS vars only if `STORAGE_MODE=s3`).
- [ ] Trigger a manual `workflow_dispatch` run and confirm it is **green**.
