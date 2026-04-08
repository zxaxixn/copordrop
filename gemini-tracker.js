require('dotenv').config();
const OpenAI = require('openai');
const { getPcppPrice, getPcppReference } = require('./pcpp');
const { readDB, writeDB } = require('./db');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(promise, ms, label) {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`OpenAI search timed out after ${ms / 1000}s for: ${label}`)), ms)
    );
    return Promise.race([promise, timeout]);
}

function parseOutputText(response) {
    return response.output
        .filter(o => o.type === 'message')
        .flatMap(o => o.content)
        .filter(c => c.type === 'output_text')
        .map(c => c.text).join('').trim();
}

// ── OpenAI Web Search ────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getOpenAIPrice(productName) {
    if (!process.env.OPENAI_API_KEY) throw new Error('No OPENAI_API_KEY');

    const today = new Date().toLocaleDateString('en-AE', { day: 'numeric', month: 'long', year: 'numeric' });

    const response = await withTimeout(openai.responses.create({
        model: 'gpt-4o',
        tools: [{ type: 'web_search_preview', search_context_size: 'high' }],
        input: `Today is ${today}. Search for the current ${today} UAE retail price of the exact product: "${productName}".

Rules:
- Only match the EXACT model name — do NOT include prices for similar or related variants (e.g. if searching for "RTX 5080", ignore "RTX 5080 Super", "RTX 5070 Ti", etc.)
- Search noon.com, amazon.ae, sharafdg.com, microless.com, and any other UAE retailer you find
- Use the LOWEST price you find for that exact model (not an average)
- Ignore bundle deals, combo listings, or used items
- CRITICAL: Only use prices that are live and current as of ${today}. Do NOT use cached results, training data, or prices from 2024 or early 2025 — those are outdated.
- If the product is RAM (e.g. "DDR5 32GB" or "DDR4 16GB"), the price MUST be for the complete kit as listed — a "32GB" kit means a dual-channel 2×16GB package. Do NOT return the price of a single stick.
- Respond with ONLY this JSON, no other text: {"price": 3250, "retailer": "noon.ae", "note": "optional short note if uncertain"}

If you cannot find the exact product on any UAE retailer, respond with: {"price": 0, "retailer": "", "note": "not found"}`
    }), 45000, productName);

    const text = parseOutputText(response);

    // Try JSON parse first
    let price;
    try {
        const jsonMatch = text.match(/\{[^}]*"price"\s*:\s*(\d+)[^}]*\}/);
        if (jsonMatch) {
            price = parseInt(jsonMatch[1], 10);
        } else {
            const parsed = JSON.parse(text);
            price = parseInt(parsed.price, 10);
        }
    } catch {
        // Fallback: find all standalone numbers in valid price range, take median
        const nums = [...text.matchAll(/(?<![/\w])(\d{3,6})(?!\d)/g)]
            .map(m => parseInt(m[1], 10))
            .filter(n => n >= 200 && n <= 500000);
        if (nums.length > 0) {
            nums.sort((a, b) => a - b);
            price = nums[Math.floor(nums.length / 2)];
        }
    }

    // If exact search returned "not found", retry with a broader query
    if (!price || price === 0) {
        const retry = await withTimeout(openai.responses.create({
            model: 'gpt-4o',
            tools: [{ type: 'web_search_preview', search_context_size: 'high' }],
            input: `Today is ${today}. Search for the current price of "${productName}" in UAE AED as of ${today}. Find any UAE retailer selling this product right now — do not use old cached prices from 2024 or early 2025. Use the lowest current price found. Respond with ONLY: {"price": 1234, "retailer": "site name"}`
        }), 45000, productName);
        const retryText = parseOutputText(retry);
        try {
            const m = retryText.match(/\{[\s\S]*\}/);
            if (m) {
                const parsed = JSON.parse(m[0]);
                price = parseInt(parsed.price, 10);
            }
        } catch {}
    }

    if (!price || price < 200 || price > 500000) throw new Error(`Invalid price from OpenAI: "${text.slice(0, 120)}"`);

    let retailer = '';
    try { retailer = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}').retailer || ''; } catch {}

    return { price, source: `OpenAI Web Search${retailer ? ` (${retailer})` : ''}` };
}

let isTracking = false;
let cancelRequested = false;

function cancelTracking() {
    if (isTracking) {
        cancelRequested = true;
        console.log('[Tracker] Cancel requested — will stop after current product.');
    }
}

// Generate weekly price history from Jan 5 2026 to yesterday using current price as baseline
function backfillHistory(price) {
    const history = [];
    const start   = new Date('2026-01-05');
    const end     = new Date(); end.setDate(end.getDate() - 1);

    const current = new Date(start);
    while (current <= end) {
        history.push({ date: current.toISOString().slice(0, 10), price });
        current.setDate(current.getDate() + 7);
    }
    return history;
}

async function trackAllPrices(singleProductId = null) {
    if (isTracking) {
        console.log('[Tracker] Already running, skipping.');
        return { updated: 0, total: 0, errors: [], skipped: true };
    }

    const db    = readDB();
    const today = new Date().toISOString().slice(0, 10);
    let updated = 0;
    const errors = [];

    const products = singleProductId
        ? db.products.filter(p => p.id === singleProductId)
        : db.products;

    if (singleProductId && !products.length)
        return { updated: 0, total: 0, errors: [{ product: singleProductId, error: 'Product not found' }] };

    isTracking = true;
    cancelRequested = false;

    console.log(`[${new Date().toISOString()}] Price tracker — ${products.length} product(s)`);

    try {
        for (const product of products) {
            console.log(`  → ${product.name} …`);
            try {
                let result = null;

                // ── 1. Fetch PCPartPicker reference → price fallback only ────
                let msrpRef = null;
                try {
                    msrpRef = await getPcppReference(product.name, product.category);
                    if (msrpRef) console.log(`      📌 PCPP ref: AED ${msrpRef.aedEquiv.toLocaleString()}`);
                } catch (e) { /* silent — PCPP is optional */ }

                // ── 2. Try OpenAI Web Search first (live web, no browser) ────
                try {
                    result = await getOpenAIPrice(product.name);
                    console.log(`      ✓ OpenAI Search: AED ${result.price.toLocaleString()}`);
                } catch (e) {
                    console.log(`      ✗ OpenAI: ${e.message}`);
                }

                // ── 3. Fall back to PCPartPicker as price if OpenAI failed ──
                if (!result && msrpRef) {
                    result = { price: msrpRef.aedEquiv, source: `PCPartPicker (US $${msrpRef.usdPrice} → AED)` };
                    console.log(`      ✓ PCPartPicker fallback: AED ${result.price.toLocaleString()}`);
                }

                if (!result) throw new Error('OpenAI and PCPartPicker both unavailable');

                // ── 4. Validate against reference price ──────────────────
                if (!db.priceHistory) db.priceHistory = {};
                if (!db.priceHistory[product.id]) db.priceHistory[product.id] = [];

                // Anchor priority: manualMsrp → PCPP reference
                const anchor = product.manualMsrp || (msrpRef ? msrpRef.aedEquiv : null);

                if (anchor) {
                    const ratio = result.price / anchor;
                    if (ratio < 0.3 || ratio > 4.0) {
                        throw new Error(
                            `Price check failed — AED ${result.price.toLocaleString()} is ` +
                            `${Math.round(ratio * 100)}% of ref AED ${anchor.toLocaleString()}`
                        );
                    }
                    if (product.manualMsrp) console.log(`      📌 Ref price check passed (AED ${anchor.toLocaleString()})`);
                }

                // ── 4. Save ───────────────────────────────────────────────
                product.price     = result.price;
                product.checkedAt = new Date().toISOString();

                if (db.priceHistory[product.id].length === 0) {
                    db.priceHistory[product.id] = backfillHistory(result.price);
                    console.log(`      (backfilled history from Jan 5)`);
                }

                const existing = db.priceHistory[product.id].findIndex(e => e.date === today);
                if (existing >= 0) {
                    db.priceHistory[product.id][existing].price = result.price;
                } else {
                    db.priceHistory[product.id].push({ date: today, price: result.price });
                }
                db.priceHistory[product.id].sort((a, b) => a.date.localeCompare(b.date));

                console.log(`      ✅ AED ${result.price.toLocaleString()} (${result.source})`);
                updated++;
                writeDB(db); // save progress after every successful update

            } catch (e) {
                console.log(`      ❌ FAILED — ${e.message}`);
                errors.push({ product: product.name, error: e.message });
            }

            await sleep(2000);

            if (cancelRequested) {
                console.log('[Tracker] Cancelled by user.');
                break;
            }
        }
    } finally {
        isTracking = false;
        cancelRequested = false;
    }

    console.log(`\n✅ Done. ${updated}/${products.length} updated.\n`);
    return { updated, total: products.length, errors };
}

if (require.main === module) {
    trackAllPrices().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = {
    trackAllPrices,
    trackProduct: (id) => trackAllPrices(id),
    cancelTracking,
    getTrackingStatus: () => ({ isTracking, cancelRequested })
};
