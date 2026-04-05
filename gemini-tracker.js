require('dotenv').config();
const puppeteer        = require('puppeteer-core');
const chromium         = require('@sparticuz/chromium');
const { getPcppPrice } = require('./pcpp');
const { readDB, writeDB } = require('./db');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Generate weekly price history from Jan 5 2026 to yesterday using current price as baseline
function backfillHistory(price) {
    const history = [];
    const start   = new Date('2026-01-05');
    const end     = new Date(); end.setDate(end.getDate() - 1); // yesterday

    const current = new Date(start);
    while (current <= end) {
        history.push({
            date:  current.toISOString().slice(0, 10),
            price: price
        });
        current.setDate(current.getDate() + 7);
    }
    return history;
}

async function newStealthPage(browser) {
    const page = await browser.newPage();
    // Hide automation flags
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
    });
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AE,en;q=0.9' });
    return page;
}

async function scrapeAmazonAE(browser, productName) {
    const page = await newStealthPage(browser);
    try {
        const url = `https://www.amazon.ae/s?k=${encodeURIComponent(productName)}&i=electronics`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(2000);

        // Check for CAPTCHA
        const isCaptcha = await page.$('.a-box-inner h4') !== null;
        if (isCaptcha) throw new Error('Amazon CAPTCHA detected');

        const { prices, listingCount } = await page.evaluate(() => {
            const results = [];
            let total = 0;
            const items = document.querySelectorAll('[data-component-type="s-search-result"]');
            for (const item of items) {
                if (item.querySelector('.puis-sponsored-label-text, [aria-label="Sponsored"]')) continue;
                total++;
                const priceEl = item.querySelector('.a-price .a-offscreen');
                if (!priceEl) continue;
                const text = priceEl.textContent.trim();
                const num = parseFloat(text.replace(/[^0-9.]/g, ''));
                if (num >= 200 && num <= 500000) results.push(Math.round(num));
            }
            return { prices: results, listingCount: total };
        });

        if (!prices.length) throw new Error('No prices found');

        // Low-stock guard: fewer than 3 organic listings means unreliable data
        if (listingCount < 3) throw new Error(`Low stock — only ${listingCount} listing(s) found, skipping`);

        // Store listing count on result so sanity check can use the right threshold
        const isLowStock = listingCount < 5;

        // Remove outliers: keep only prices within 50% of the median
        prices.sort((a, b) => a - b);
        const median = prices[Math.floor(prices.length / 2)];
        const filtered = prices.filter(p => p >= median * 0.5 && p <= median * 2);
        const result_prices = filtered.length ? filtered : prices;
        const avg = Math.round(result_prices.reduce((s, p) => s + p, 0) / result_prices.length);
        return { price: avg, source: 'Amazon.ae', lowStock: isLowStock };

    } catch (e) {
        throw e;
    } finally {
        await page.close();
    }
}

async function scrapeNoon(browser, productName) {
    const page = await newStealthPage(browser);
    try {
        const url = `https://www.noon.com/uae-en/search/?q=${encodeURIComponent(productName)}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(3000);

        const prices = await page.evaluate(() => {
            const results = [];
            // Noon prices are plain numbers like "14315" inside price elements
            const priceEls = document.querySelectorAll(
                '[class*="price"] strong, [class*="Price"] strong, ' +
                '[class*="amount"], [data-qa="price-amount"]'
            );
            priceEls.forEach(el => {
                const num = parseInt(el.textContent.replace(/[^0-9]/g, ''), 10);
                if (num >= 200 && num <= 500000) results.push(num);
            });
            return results;
        });

        if (!prices.length) throw new Error('No prices found');

        prices.sort((a, b) => a - b);
        const median = prices[Math.floor(prices.length / 2)];
        const filtered = prices.filter(p => p >= median * 0.5 && p <= median * 2);
        const result_prices = filtered.length ? filtered : prices;
        const avg = Math.round(result_prices.reduce((s, p) => s + p, 0) / result_prices.length);
        return { price: avg, source: 'Noon.com' };

    } catch (e) {
        throw e;
    } finally {
        await page.close();
    }
}

async function trackAllPrices() {
    const db    = readDB();
    const today = new Date().toISOString().slice(0, 10);
    let updated = 0;
    const errors = [];

    console.log(`[${new Date().toISOString()}] Price tracker — ${db.products.length} products`);

    const browser = await puppeteer.launch({
        args: [...chromium.args, '--disable-blink-features=AutomationControlled', '--disable-infobars', '--window-size=1366,768'],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
    });

    try {
        for (const product of db.products) {
            process.stdout.write(`  → ${product.name} … `);
            try {
                // Try PCPartPicker first, then Amazon.ae, then Noon
                let result = null;
                try {
                    result = await getPcppPrice(product.name, product.category);
                } catch (e) {
                    console.log(`\n    PCPartPicker failed (${e.message}), trying Amazon…`);
                    try {
                        result = await scrapeAmazonAE(browser, product.name);
                    } catch (e2) {
                        console.log(`\n    Amazon failed (${e2.message}), trying Noon…`);
                        result = await scrapeNoon(browser, product.name);
                    }
                }

                // Sanity check: reject if price swings >40% from last known price
                if (!db.priceHistory) db.priceHistory = {};
                if (!db.priceHistory[product.id]) db.priceHistory[product.id] = [];
                const lastKnown  = db.priceHistory[product.id].slice(-1)[0];
                const threshold  = result.lowStock ? 0.10 : 0.40; // 10% for low-stock, 40% for normal
                if (lastKnown && lastKnown.price > 0) {
                    const change = Math.abs(result.price - lastKnown.price) / lastKnown.price;
                    if (change > threshold) {
                        throw new Error(
                            `Sanity check failed — AED ${result.price.toLocaleString()} is ` +
                            `${Math.round(change * 100)}% away from last known AED ${lastKnown.price.toLocaleString()} ` +
                            `(threshold: ${Math.round(threshold * 100)}%)`
                        );
                    }
                }

                product.price     = result.price;
                product.checkedAt = new Date().toISOString();

                // First time tracking this product — backfill weekly history from Jan 5
                if (db.priceHistory[product.id].length === 0) {
                    db.priceHistory[product.id] = backfillHistory(result.price);
                    console.log(`\n    (backfilled history from Jan 5)`);
                    process.stdout.write('  ');
                }

                const existing = db.priceHistory[product.id].findIndex(e => e.date === today);
                if (existing >= 0) {
                    db.priceHistory[product.id][existing].price = result.price;
                } else {
                    db.priceHistory[product.id].push({ date: today, price: result.price });
                }
                db.priceHistory[product.id].sort((a, b) => a.date.localeCompare(b.date));

                console.log(`AED ${result.price.toLocaleString()} (${result.source})`);
                updated++;
            } catch (e) {
                console.log(`FAILED — ${e.message}`);
                errors.push({ product: product.name, error: e.message });
            }

            await sleep(3000);
        }
    } finally {
        await browser.close();
    }

    writeDB(db);
    console.log(`\n✅ Done. ${updated}/${db.products.length} updated.\n`);
    return { updated, total: db.products.length, errors };
}

if (require.main === module) {
    trackAllPrices().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { trackAllPrices };
