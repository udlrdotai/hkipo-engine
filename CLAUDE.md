# CLAUDE.md

## Project Overview

hkipo-engine is a Cloudflare Workers service that tracks Hong Kong Main Board IPO filings. It discovers new prospectuses from HKEXnews, stores structured data in D1, and exposes APIs for querying and managing IPO data.

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Database**: Cloudflare D1 (SQLite)
- **Object Storage**: Cloudflare R2
- **Language**: TypeScript (ESNext, strict mode)
- **Deploy**: `wrangler deploy` (always deploy remotely, never use `wrangler dev`)
- **Environments**: `dev` (`--env dev`) and `prod` (`--env prod`). There is no default environment — every wrangler command MUST pass `--env`.

## Project Structure

```
src/
├── index.ts              # App entry, route registration, cron handler
├── models/types.ts       # Core types: Company, IPO, Filing, Env
├── routes/
│   ├── ipo.ts            # GET /api/ipo, GET /api/ipo/:id
│   ├── filing.ts         # GET /api/filing/:id
│   └── admin.ts          # /admin/api/* (Bearer token auth)
├── services/
│   └── discovery.ts      # HKEXnews scraper, filing persistence
└── db/
    └── schema.sql        # D1 schema (4 tables)
```

## Database Tables

- **company** — company name (en/tc), stock_code, industry
- **ipo** — links to company, board (Main only), status (offering/listed/withdrawn)
- **filing** — prospectus PDF links, lang (en/tc), source_url
- **prospectus** — structured extracted data, core fields as columns + JSON columns for arrays (financials, cornerstone_investors, etc.), status (pending/crawled/parsed/failed)

## API Endpoints

Public:
- `GET /` — health check
- `POST /api/discover` — manual trigger for HKEXnews scraping
- `GET /api/ipo/` — list IPOs (filter: ?status=, ?board=)
- `GET /api/ipo/:id` — IPO detail + filings
- `GET /api/filing/:id` — filing metadata

Admin (requires `Authorization: Bearer <ADMIN_API_KEY>`):
- `GET /admin/api/prospectus/pending` — pending prospectuses with PDF URLs
- `POST /admin/api/prospectus` — submit parsed prospectus data (upsert)
- `PATCH /admin/api/prospectus/:stock_code/status` — update status

## Key Design Decisions

- **Main Board only** — GEM board IPOs are excluded
- **prospectus table is independent** — no foreign keys to company/ipo tables, self-contained
- **JSON columns for array data** — cornerstone_investors, financials, use_of_proceeds etc. stored as JSON strings, queryable via `json_extract()`
- **VPS handles PDF parsing** — VPS polls pending prospectuses, downloads PDFs, extracts data with Python (pypdf), submits results back via admin API
- **No DOM parser** — discovery.ts uses regex for HTML parsing (Workers has no DOMParser)

## Environments

| | Dev (`--env dev`) | Prod (`--env prod`) |
|---|---|---|
| Worker name | `hkipo-engine` | `hkipo-engine-production` |
| D1 database | `hkipo-db` | `hkipo-db-prod` |
| Domain | — | `hkiporadar.com` |
| Cron | — | `*/30 1-10 * * 1-5` |
| Secrets source | `.dev.vars` | `wrangler secret put --env prod` |

**⚠ There is no default environment. Every `wrangler` command MUST pass `--env dev` or `--env prod`. Omitting `--env` will fail or hit the wrong target.**

## Commands

Common:
```bash
npx tsc --noEmit                       # type check
```

Dev:
```bash
npx wrangler deploy --env dev                                                  # deploy dev worker
npx wrangler d1 execute hkipo-db --remote --env dev --command "..."            # run SQL on dev D1
npx wrangler secret put <KEY> --env dev                                        # set dev secret
```

Prod:
```bash
npx wrangler deploy --env prod                                                 # deploy prod worker
npx wrangler d1 execute hkipo-db-prod --remote --env prod --command "..."      # run SQL on prod D1
npx wrangler secret put <KEY> --env prod                                       # set prod secret
```

## Cron

`*/30 1-10 * * 1-5` — every 30 min, Mon-Fri 09:00-18:00 HKT (UTC+8), runs `discover()`.

## Secrets

- `ADMIN_API_KEY` — Bearer token for /admin/api/* routes
  - Dev: stored in `.dev.vars` (or `npx wrangler secret put ADMIN_API_KEY --env dev`)
  - Prod: `npx wrangler secret put ADMIN_API_KEY --env prod`

## Conventions

- Dates stored as ISO 8601 TEXT in D1
- All financial amounts paired with `currency` and `unit` fields
- Prospectus PDF source URLs come from HKEXnews (www1.hkexnews.hk)
- Bilingual: en (English) + tc (Traditional Chinese)
