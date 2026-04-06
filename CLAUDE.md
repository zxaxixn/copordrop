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
- `index.html` — Main frontend, cop/drop verdict UI, Claude agentic tool-use loop
- `admin.html` — Admin panel: add/edit/delete products, trigger price tracking, seed/clear ref prices

## How price tracking works
1. OpenAI searches UAE retailers (noon.com, amazon.ae, sharafdg.com, microless.com) for exact model
2. If not found, retries with a broader query
3. Falls back to PCPartPicker US price converted to AED if OpenAI fails
4. Validates result against `manualMsrp` anchor (0.3x–4.0x ratio check)
5. Saves to `priceHistory[productId]` array

## How the cop/drop verdict works
1. Frontend fetches DB prices + OpenAI Dubizzle used listings
2. Passes both as context to Claude (`claude-sonnet-4-6`) via `/api/claude`
3. Claude has a `web_search` tool — when called, frontend hits `/api/search` (OpenAI web search) and feeds results back
4. Agentic loop handles multiple tool calls per response correctly
5. Claude returns `VERDICT: COP / DROP / SCAM RISK` + analysis

## Environment variables needed
- `OPENAI_API_KEY` — price tracking + search
- `ANTHROPIC_API_KEY` — Claude verdicts and price predictions
- `ADMIN_PASSWORD` — admin panel login
- `MONGODB_URI` — MongoDB connection (optional, falls back to db.json)
- `AMAZON_AFFILIATE_TAG` — optional, appended to Amazon links

## Admin panel (`/admin`)
Buttons: Track Prices, Seed Ref Prices, Clear Ref Prices, Clear History, Sign Out

## Things to know
- The tracker file is called `gemini-tracker.js` but uses OpenAI — don't rename, too many references
- `scrapers.js` was deleted — Google search and Dubizzle now use OpenAI `web_search_preview`
- PCPartPicker `puppeteer-core` dependency is still needed by `pcpp.js`
- Price history is backfilled from Jan 5 2026 on first track
- `manualMsrp` on a product overrides PCPartPicker as the validation anchor
