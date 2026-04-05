require('dotenv').config();
const { launchStealthBrowser, scrapeUAEPrice } = require('./scraper-engine');
const { getPcppPrice } = require('./pcpp');
const { readDB, writeDB } = require('./db');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    let browser  = null;

    console.log(`[${new Date().toISOString()}] Price tracker — ${db.products.length} products`);

    try {
        for (const product of db.products) {
            console.log(`  → ${product.name} …`);
            try {
                let result = null;

                // ── 1. Try PCPartPicker first (no browser, fast) ──────────
                try {
                    result = await getPcppPrice(product.name, product.category);
                    console.log(`      ✓ PCPartPicker: ${result.source}`);
                } catch (e) {
                    console.log(`      ✗ PCPartPicker: ${e.message}`);
                }

                // ── 2. If PCPP failed, scrape UAE sites ───────────────────
                if (!result) {
                    // Launch browser on demand — only when actually needed
                    if (!browser) {
                        console.log('      [Launching stealth browser…]');
                        browser = await launchStealthBrowser();
                    } else if (!browser.isConnected()) {
                        console.log('      [Browser crashed, relaunching…]');
                        browser = await launchStealthBrowser();
                    }
                    result = await scrapeUAEPrice(browser, product.name);
                }

                // ── 3. Sanity check ───────────────────────────────────────
                if (!db.priceHistory) db.priceHistory = {};
                if (!db.priceHistory[product.id]) db.priceHistory[product.id] = [];
                const lastKnown = db.priceHistory[product.id].slice(-1)[0];
                if (lastKnown && lastKnown.price > 0) {
                    const change = Math.abs(result.price - lastKnown.price) / lastKnown.price;
                    // PCPartPicker is a trusted source — allow up to 80% swing
                    // UAE scrapers (Noon etc.) allow 40%
                    const threshold = result.source.includes('PCPartPicker') ? 0.80 : 0.40;
                    if (change > threshold) {
                        throw new Error(
                            `Sanity check failed — AED ${result.price.toLocaleString()} is ` +
                            `${Math.round(change * 100)}% away from last known AED ${lastKnown.price.toLocaleString()}`
                        );
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
        if (browser) {
            try { await browser.close(); } catch {}
        }
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
