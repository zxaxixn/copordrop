/**
 * scraper-engine.js — Stealth multi-source UAE price scraper
 * Sources: Noon.ae, Sharaf DG, Microless, Virgin Megastore UAE
 *
 * Uses puppeteer-extra + stealth plugin to bypass bot detection.
 * Rotates user agents and sets realistic browser fingerprints.
 * Aggregates prices from all available sources and averages them.
 */
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
const chromium       = require('@sparticuz/chromium');

puppeteerExtra.use(StealthPlugin());

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── User agent pool (real Chrome versions, multiple OS) ──────────────
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function randomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Browser management ───────────────────────────────────────────────
async function launchStealthBrowser() {
    return puppeteerExtra.launch({
        args: [
            ...chromium.args,
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--window-size=1440,900',
            '--no-zygote',
        ],
        defaultViewport: { width: 1440, height: 900 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
}

async function stealthPage(browser) {
    const page = await browser.newPage();
    const ua   = randomUA();

    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({
        'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language':           'en-AE,en;q=0.9,ar-AE;q=0.8,ar;q=0.7',
        'Accept-Encoding':           'gzip, deflate, br',
        'sec-ch-ua':                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile':          '?0',
        'sec-ch-ua-platform':        '"Windows"',
        'sec-fetch-dest':            'document',
        'sec-fetch-mode':            'navigate',
        'sec-fetch-site':            'none',
        'sec-fetch-user':            '?1',
        'upgrade-insecure-requests': '1',
        'cache-control':             'max-age=0',
    });

    // Extra stealth: hide automation via JS
    await page.evaluateOnNewDocument(() => {
        delete navigator.__proto__.webdriver;
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-AE', 'en', 'ar'] });
        window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    });

    return page;
}

// ── Price utilities ──────────────────────────────────────────────────
function averagePrices(prices, min = 200, max = 500000) {
    const valid = prices.filter(p => p >= min && p <= max);
    if (!valid.length) return null;
    valid.sort((a, b) => a - b);
    const median   = valid[Math.floor(valid.length / 2)];
    const filtered = valid.filter(p => p >= median * 0.5 && p <= median * 2);
    const arr      = filtered.length ? filtered : valid;
    return Math.round(arr.reduce((s, p) => s + p, 0) / arr.length);
}

function parsePricesFromText(text, min = 200, max = 500000) {
    const prices = [];
    // Match AED prices in various formats
    const patterns = [
        /AED\s*([\d,]+(?:\.\d{1,2})?)/gi,
        /د\.إ\s*([\d,]+(?:\.\d{1,2})?)/g,
    ];
    for (const rx of patterns) {
        let m;
        while ((m = rx.exec(text)) !== null) {
            const n = parseFloat(m[1].replace(/,/g, ''));
            if (n >= min && n <= max) prices.push(Math.round(n));
        }
    }
    return prices;
}

// ── Noon.ae ──────────────────────────────────────────────────────────
async function scrapeNoon(browser, query) {
    const page = await stealthPage(browser);
    try {
        await page.goto(
            `https://www.noon.com/uae-en/search/?q=${encodeURIComponent(query)}&sort_by=popularity`,
            { waitUntil: 'domcontentloaded', timeout: 60000 }
        );
        await sleep(3500);

        const prices = await page.evaluate(() => {
            const results = [];
            const selectors = [
                '[class*="priceNow"]',
                '[class*="price-now"]',
                '[class*="amount"]',
                '[data-qa="price-amount"]',
                '[class*="Price"] strong',
                '[class*="price"] strong',
                '.sc-bdXHTO',
            ];
            for (const sel of selectors) {
                document.querySelectorAll(sel).forEach(el => {
                    const raw = el.textContent.replace(/[^\d.]/g, '');
                    const n   = parseFloat(raw);
                    if (n >= 200 && n <= 500000) results.push(Math.round(n));
                });
            }
            return [...new Set(results)];
        });

        const avg = averagePrices(prices);
        if (!avg) throw new Error('No prices found');
        return { price: avg, source: 'Noon.ae' };
    } finally {
        await page.close().catch(() => {});
    }
}

// ── Sharaf DG ────────────────────────────────────────────────────────
async function scrapeSharafDG(browser, query) {
    const page = await stealthPage(browser);
    try {
        await page.goto(
            `https://www.sharafdg.com/search?q=${encodeURIComponent(query)}`,
            { waitUntil: 'domcontentloaded', timeout: 60000 }
        );
        await sleep(3000);

        const text   = await page.evaluate(() => document.body.innerText);
        const prices = parsePricesFromText(text);

        // Also try structured price elements
        const elPrices = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('.price, .special-price, [class*="price"], [data-price]').forEach(el => {
                const raw = el.textContent.replace(/[^\d.]/g, '');
                const n   = parseFloat(raw);
                if (n >= 200 && n <= 500000) results.push(Math.round(n));
            });
            return results;
        });

        const all = [...new Set([...prices, ...elPrices])];
        const avg = averagePrices(all);
        if (!avg) throw new Error('No prices found');
        return { price: avg, source: 'Sharaf DG' };
    } finally {
        await page.close().catch(() => {});
    }
}

// ── Microless.com ────────────────────────────────────────────────────
async function scrapeMicroless(browser, query) {
    const page = await stealthPage(browser);
    try {
        await page.goto(
            `https://www.microless.com/search/?q=${encodeURIComponent(query)}`,
            { waitUntil: 'domcontentloaded', timeout: 60000 }
        );
        await sleep(2500);

        const prices = await page.evaluate(() => {
            const results = [];
            // Microless shows AED prices
            document.querySelectorAll(
                '.product-price, [class*="price"], [class*="Price"], .price-new, .price-normal'
            ).forEach(el => {
                const text = el.textContent.trim();
                const m    = text.match(/AED\s*([\d,]+(?:\.\d{1,2})?)/i)
                          || text.match(/^[\d,]+(?:\.\d{1,2})?$/);
                if (m) {
                    const n = parseFloat(m[m.length - 1].replace(/,/g, ''));
                    if (n >= 200 && n <= 500000) results.push(Math.round(n));
                }
            });
            return [...new Set(results)];
        });

        const avg = averagePrices(prices);
        if (!avg) throw new Error('No prices found');
        return { price: avg, source: 'Microless' };
    } finally {
        await page.close().catch(() => {});
    }
}

// ── Virgin Megastore UAE ─────────────────────────────────────────────
async function scrapeVirgin(browser, query) {
    const page = await stealthPage(browser);
    try {
        await page.goto(
            `https://www.virginmegastore.ae/en/search?q=${encodeURIComponent(query)}`,
            { waitUntil: 'domcontentloaded', timeout: 60000 }
        );
        await sleep(3000);

        const text   = await page.evaluate(() => document.body.innerText);
        const prices = parsePricesFromText(text);
        const avg    = averagePrices(prices);
        if (!avg) throw new Error('No prices found');
        return { price: avg, source: 'Virgin UAE' };
    } finally {
        await page.close().catch(() => {});
    }
}

// ── Multi-source aggregator ──────────────────────────────────────────
// Tries all UAE sources in parallel, averages all that succeed
async function scrapeUAEPrice(browser, productName) {
    const scrapers = [
        { name: 'Noon',      fn: () => scrapeNoon(browser, productName)      },
        { name: 'Sharaf DG', fn: () => scrapeSharafDG(browser, productName)  },
        { name: 'Microless', fn: () => scrapeMicroless(browser, productName) },
        { name: 'Virgin',    fn: () => scrapeVirgin(browser, productName)    },
    ];

    const results = [];
    for (const { name, fn } of scrapers) {
        try {
            const r = await fn();
            results.push(r);
            console.log(`      ✓ ${r.source}: AED ${r.price.toLocaleString()}`);
        } catch (e) {
            console.log(`      ✗ ${name}: ${e.message}`);
        }
        await sleep(1000); // small gap between sites
    }

    if (!results.length) throw new Error('All UAE sources failed');

    const prices    = results.map(r => r.price);
    const avg       = averagePrices(prices);
    const sourceStr = results.map(r => r.source).join(' + ');
    return { price: avg, source: sourceStr };
}

module.exports = { launchStealthBrowser, scrapeUAEPrice, scrapeNoon, scrapeSharafDG, scrapeMicroless, scrapeVirgin };
