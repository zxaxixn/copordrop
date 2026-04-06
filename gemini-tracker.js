require('dotenv').config();
const OpenAI = require('openai');
const { getPcppPrice, getPcppReference } = require('./pcpp');
const { readDB, writeDB } = require('./db');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── OpenAI Web Search ────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getOpenAIPrice(productName) {
    if (!process.env.OPENAI_API_KEY) throw new Error('No OPENAI_API_KEY');

    const response = await openai.responses.create({
        model: 'gpt-4o',
        tools: [{ type: 'web_search_preview' }],
        input: `Search for the current retail price of "${productName}" in the UAE in AED from multiple retailers (noon.com, amazon.ae, sharafdg.com, etc). Find prices from 2-3 different stores, calculate the average, and respond with ONLY a JSON object like this: {"price": 3250}. No other text.`
    });

    const text = response.output.filter(o => o.type === 'message')
                                .flatMap(o => o.content)
                                .filter(c => c.type === 'output_text')
                                .map(c => c.text).join('').trim();

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

    if (!price || price < 200 || price > 500000) throw new Error(`Invalid price from OpenAI: "${text.slice(0, 120)}"`);

    return { price, source: 'OpenAI Web Search' };
}

let isTracking = false;

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

async function trackAllPrices() {
    if (isTracking) {
        console.log('[Tracker] Already running, skipping.');
        return { updated: 0, total: 0, errors: [], skipped: true };
    }
    isTracking = true;

    const db    = readDB();
    const today = new Date().toISOString().slice(0, 10);
    let updated = 0;
    const errors = [];
    console.log(`[${new Date().toISOString()}] Price tracker — ${db.products.length} products`);

    try {
        for (const product of db.products) {
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

                // ── 4. Validate against manual reference price ────────────
                if (!db.priceHistory) db.priceHistory = {};
                if (!db.priceHistory[product.id]) db.priceHistory[product.id] = [];

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

            } catch (e) {
                console.log(`      ❌ FAILED — ${e.message}`);
                errors.push({ product: product.name, error: e.message });
            }

            await sleep(2000);
        }
    } finally {
        isTracking = false;
    }

    writeDB(db);
    console.log(`\n✅ Done. ${updated}/${db.products.length} updated.\n`);
    return { updated, total: db.products.length, errors };
}

if (require.main === module) {
    trackAllPrices().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { trackAllPrices };
