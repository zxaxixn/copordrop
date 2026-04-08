# CopOrDrop.ae — Project Context

## What it is
A UAE PC hardware price tracker and deal checker. Users paste a listing and get a **COP / DROP / SCAM RISK** verdict powered by Claude. Prices for 108 tracked products (GPUs, CPUs, RAM, SSDs, monitors, cases, coolers, PSUs, fans, motherboards) are updated daily using OpenAI web search.

## Stack
- **Backend**: Node.js + Express (`server.js`)
- **Database**: MongoDB (production) + `db.json` (local fallback) via `db.js`
- **Hosting**: Render (previously Railway) — port set by `process.env.PORT`, defaults to 3000
- **AI**: Claude (Anthropic) for cop/drop reasoning, OpenAI `gpt-4o` with `web_search_preview` for price tracking and search
- **PCPartPicker**: US reference prices via GitHub Pages JSON + Puppeteer fallback (`pcpp.js`)

## Key files
- `server.js` — Express server, all API routes, daily cron job (11 PM UAE / 19:00 UTC)
- `gemini-tracker.js` — Daily price tracker using OpenAI Responses API; named "gemini" historically but uses OpenAI
- `pcpp.js` — PCPartPicker price fetcher (US prices → AED conversion at 3.67 rate + 15% UAE margin)
- `db.js` — Shared DB module, sync readDB/writeDB API backed by MongoDB + local file
- `index.html` — Main frontend, cop/drop verdict UI, Claude agentic tool-use loop, PC Builder
- `admin.html` — Admin panel: add/edit/delete products, trigger price tracking, seed/clear ref prices

## How price tracking works
1. OpenAI searches UAE retailers (noon.com, amazon.ae, sharafdg.com, microless.com) for exact model
2. If not found, retries with a broader query
3. Falls back to PCPartPicker US price converted to AED if OpenAI fails
4. Validates result against `manualMsrp` anchor (0.3x–4.0x ratio check) — PCPP reference used if no manualMsrp
5. `writeDB` is called after every successful product so progress is never lost if the process is interrupted
- Each prompt includes today's date and explicitly tells OpenAI to ignore cached/2024–2025 results
- `search_context_size: 'high'` is set on the `web_search_preview` tool to force comprehensive live results
- All OpenAI calls have a 45-second timeout via `withTimeout()` so the tracker never hangs on a single product
- RAM searches include an explicit instruction: price must be for the full kit, not a single stick
- DB price is NOT used as a validation anchor (was removed — old DB data was flawed)

## How the cop/drop verdict works
1. Frontend fetches DB prices + OpenAI Dubizzle used listings
2. Passes both as context to Claude (`claude-sonnet-4-6`) via `/api/claude`
3. Claude has a `web_search` tool — when called, frontend hits `/api/search` (OpenAI web search) and feeds results back
4. Agentic loop handles multiple tool calls per response correctly
5. Claude returns `VERDICT: COP / DROP / SCAM RISK` + analysis

## How the PC Builder works
1. User enters a budget (AED) and optionally toggles "include used parts from Dubizzle"
2. Frontend fetches live DB prices and injects them as context
3. Claude (`claude-sonnet-4-6`) uses the same agentic tool-use loop via `/api/claude` + `/api/search`
4. Claude searches for parts not in the DB (motherboards, PSUs, cases, coolers) via `web_search`
5. Returns a JSON build with title, summary, total price, and a parts list
6. Each part renders with category emoji, name, reason, price, and buy links (Amazon, Noon, Dubizzle for used)
7. Budget tiers: <1500 AED iGPU → 1500–2500 entry GPU → 2500–4000 solid 1080p → 4000–7000 1440p → 7000+ enthusiast

## Admin panel (`/admin`)
Buttons: Track Prices, Stop (appears during tracking), Seed Ref Prices, Clear Ref Prices, Clear Prices, Clear History, Sign Out

- **Track Prices** — runs full tracker for all products in background (fire-and-forget)
- **Stop** — sends cancel signal; tracker finishes current product then stops cleanly
- **Track** (per-row button) — tracks a single product, waits for result, updates the row
- **Clear Prices** — resets all `price` values to 0, keeps products and history intact
- **Seed Ref Prices** — sets `manualMsrp` = current price for products that don't have one
- **Clear Ref Prices** — removes all `manualMsrp` values
- **Clear History** — wipes all `priceHistory` entries

## Admin API routes (all require x-admin-token header)
- `POST /api/admin/track-prices` — start full track (background)
- `POST /api/admin/track-product/:id` — track single product (awaits result)
- `POST /api/admin/cancel-tracking` — signal running tracker to stop
- `GET /api/admin/tracking-status` — returns `{ isTracking, cancelRequested }`
- `POST /api/admin/clear-prices` — zero out all prices
- `POST /api/admin/clear-history` — wipe all price history
- `POST /api/admin/clear-ref-prices` — remove all manualMsrp values
- `POST /api/admin/seed-msrp` — seed manualMsrp from current prices

## Environment variables needed
- `OPENAI_API_KEY` — price tracking + search
- `ANTHROPIC_API_KEY` — Claude verdicts and price predictions
- `ADMIN_PASSWORD` — admin panel login
- `MONGODB_URI` — MongoDB connection (optional, falls back to db.json)
- `AMAZON_AFFILIATE_TAG` — optional, appended to Amazon links

## Things to know
- The tracker file is called `gemini-tracker.js` but uses OpenAI — don't rename, too many references
- `scrapers.js` was deleted — Google search and Dubizzle now use OpenAI `web_search_preview`
- PCPartPicker `puppeteer-core` dependency is still needed by `pcpp.js`
- Price history is backfilled from Jan 5 2026 on first track
- `manualMsrp` on a product overrides PCPartPicker as the validation anchor
- To deploy: push to GitHub, Render auto-deploys from main branch
- Git push requires auth token: `git remote set-url origin https://TOKEN@github.com/zxaxixn/copordrop.git`
