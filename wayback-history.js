/**
 * wayback-history.js
 * Fetches real monthly price snapshots from the Wayback Machine for each product.
 * Run once: node wayback-history.js
 * Adds monthly history entries to db.json where snapshots exist.
 */
require('dotenv').config();
const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const DB_FILE = path.join(__dirname, 'db.json');

function readDB()      { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { products: [], priceHistory: {} }; } }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function sleep(ms)     { return new Promise(r => setTimeout(r, ms)); }

// Months to fetch: Jan, Feb, Mar 2026
const MONTHS = ['20260101', '20260201', '20260301'];

async function getWaybackUrl(productName, timestamp) {
    const amazonSearch = `www.amazon.ae/s?k=${encodeURIComponent(productName + ' graphics card UAE')}&i=electronics`;
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(amazonSearch)}&timestamp=${timestamp}`;

    const res  = await fetch(apiUrl);
    const data = await res.json();
    const snap = data?.archived_snapshots?.closest;

    if (!snap?.available || snap.status !== '200') return null;
    return snap.url; // e.g. https://web.archive.org/web/20260103.../https://www.amazon.ae/s?...
}

async function scrapePriceFromWayback(browser, waybackUrl) {
    const page = await browser.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.goto(waybackUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);

        const prices = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('.a-price .a-offscreen').forEach(el => {
                const num = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
                if (num >= 200 && num <= 500000) results.push(Math.round(num));
            });
            return results;
        });

        if (!prices.length) return null;

        prices.sort((a, b) => a - b);
        const median   = prices[Math.floor(prices.length / 2)];
        const filtered = prices.filter(p => p >= median * 0.5 && p <= median * 2);
        const sample   = filtered.length ? filtered : prices;
        return Math.round(sample.reduce((s, p) => s + p, 0) / sample.length);

    } catch (e) {
        return null;
    } finally {
        await page.close();
    }
}

async function run() {
    const db = readDB();
    if (!db.priceHistory) db.priceHistory = {};
    let totalAdded = 0;

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    try {
        for (const product of db.products) {
            console.log(`\n${product.name}`);

            for (const ts of MONTHS) {
                const dateStr = `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`;

                // Skip if we already have a real entry for this month
                const exists = (db.priceHistory[product.id] || []).some(e => e.date.startsWith(dateStr.slice(0, 7)));
                if (exists) {
                    console.log(`  ${dateStr} — already have data, skipping`);
                    continue;
                }

                process.stdout.write(`  ${dateStr} — checking Wayback… `);

                try {
                    const waybackUrl = await getWaybackUrl(product.name, ts);
                    if (!waybackUrl) { console.log('no snapshot'); continue; }

                    const price = await scrapePriceFromWayback(browser, waybackUrl);
                    if (!price)   { console.log('no price found'); continue; }

                    if (!db.priceHistory[product.id]) db.priceHistory[product.id] = [];
                    db.priceHistory[product.id].push({ date: dateStr, price });
                    db.priceHistory[product.id].sort((a, b) => a.date.localeCompare(b.date));

                    console.log(`AED ${price.toLocaleString()}`);
                    totalAdded++;
                } catch (e) {
                    console.log(`error — ${e.message}`);
                }

                await sleep(2000); // respect Wayback Machine rate limits
            }
        }
    } finally {
        await browser.close();
    }

    // Remove the fake backfill entries (price same across all weeks) for products
    // that now have real Wayback data
    for (const product of db.products) {
        const hist = db.priceHistory[product.id] || [];
        if (hist.length < 4) continue;
        // If all prices are identical, it was backfilled — remove old flat entries,
        // keeping only entries from months where we now have real data
        const prices = hist.map(h => h.price);
        const allSame = prices.every(p => p === prices[0]);
        if (allSame && prices[0] > 0) {
            // Keep only the most recent entry + any month we got from Wayback
            const waybackDates = new Set(MONTHS.map(ts => `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`));
            db.priceHistory[product.id] = hist.filter(h =>
                waybackDates.has(h.date) ||
                h.date === hist[hist.length - 1].date
            );
        }
    }

    writeDB(db);
    console.log(`\n✅ Done. Added ${totalAdded} real price snapshots.\n`);
}

run().catch(console.error);
