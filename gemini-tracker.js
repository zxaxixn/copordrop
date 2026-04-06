require('dotenv').config();
const { getPcppPrice, getPcppReference } = require('./pcpp');
const { readDB, writeDB } = require('./db');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Gemini Search grounding ──────────────────────────────────────────
async function getGeminiPrice(productName) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('No GEMINI_API_KEY');

    const prompt = `What is the current retail price of "${productName}" in the UAE in AED? Search the web and return ONLY a single number with no text, no currency symbol, no explanation. Example: 3250`;

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${key}`,
        {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                tools:    [{ google_search: {} }]
            })
        }
    );

    const data = await res.json();
    if (data.error) throw new Error(`Gemini API error: ${data.error.message}`);

    const text  = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim();
    const price = parseInt(text?.replace(/[^0-9]/g, ''), 10);
    if (!price || price < 200 || price > 500000) throw new Error(`Invalid price from Gemini: "${text}"`);

    return { price, source: 'Gemini Search' };
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

                // ── 1. Fetch PCPartPicker reference → MSRP anchor + price fallback ──
                let msrpRef = null;
                try {
                    msrpRef = await getPcppReference(product.name, product.category);
                    if (msrpRef) {
                        product.msrp = msrpRef.aedEquiv;
                        console.log(`      📌 MSRP (PCPartPicker): AED ${msrpRef.aedEquiv.toLocaleString()}`);
                    }
                } catch (e) {
                    console.log(`      ✗ MSRP lookup: ${e.message}`);
                }

                // ── 2. Try Gemini Search first (live web, no browser) ─────
                try {
                    result = await getGeminiPrice(product.name);
                    console.log(`      ✓ Gemini Search: AED ${result.price.toLocaleString()}`);
                } catch (e) {
                    console.log(`      ✗ Gemini: ${e.message}`);
                }

                // ── 3. If Gemini failed, fall back to PCPartPicker as price ──
                if (!result && msrpRef) {
                    result = { price: msrpRef.aedEquiv, source: `PCPartPicker (US $${msrpRef.usdPrice} → AED)` };
                    console.log(`      ✓ PCPartPicker fallback: AED ${result.price.toLocaleString()}`);
                }

                if (!result) throw new Error('Gemini and PCPartPicker both unavailable');

                // ── 4. Validate price ─────────────────────────────────────
                if (!db.priceHistory) db.priceHistory = {};
                if (!db.priceHistory[product.id]) db.priceHistory[product.id] = [];

                if (product.msrp) {
                    // Primary check: price must be within 50%–250% of MSRP
                    const ratio = result.price / product.msrp;
                    if (ratio < 0.5 || ratio > 2.5) {
                        throw new Error(
                            `MSRP check failed — AED ${result.price.toLocaleString()} is ` +
                            `${Math.round(ratio * 100)}% of MSRP AED ${product.msrp.toLocaleString()}`
                        );
                    }
                } else {
                    // Fallback: compare against last-known price (for products with no PCPartPicker match)
                    const lastKnown = db.priceHistory[product.id].slice(-1)[0];
                    if (lastKnown && lastKnown.price > 0) {
                        const change    = Math.abs(result.price - lastKnown.price) / lastKnown.price;
                        const threshold = (result.source.includes('PCPartPicker') || result.source.includes('Gemini')) ? 0.80 : 0.40;
                        if (change > threshold) {
                            throw new Error(
                                `Sanity check failed — AED ${result.price.toLocaleString()} is ` +
                                `${Math.round(change * 100)}% away from last known AED ${lastKnown.price.toLocaleString()}`
                            );
                        }
                    }
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
