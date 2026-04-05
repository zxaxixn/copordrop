/**
 * scrapers.js — Stealth scrapers for Google Search and Dubizzle
 * Uses puppeteer-extra + stealth plugin
 */
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
const chromium       = require('@sparticuz/chromium');

puppeteerExtra.use(StealthPlugin());

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

async function launchBrowser() {
    return puppeteerExtra.launch({
        args: [
            ...chromium.args,
            '--disable-blink-features=AutomationControlled',
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
    const ua   = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({
        'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language':           'en-AE,en;q=0.9,ar-AE;q=0.8',
        'sec-ch-ua':                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile':          '?0',
        'sec-ch-ua-platform':        '"Windows"',
        'sec-fetch-dest':            'document',
        'sec-fetch-mode':            'navigate',
        'sec-fetch-site':            'none',
        'sec-fetch-user':            '?1',
        'upgrade-insecure-requests': '1',
    });

    await page.evaluateOnNewDocument(() => {
        delete navigator.__proto__.webdriver;
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    });

    return page;
}

// ── Google Search ─────────────────────────────────────────────────────
async function scrapeGoogleSearch(query) {
    const browser = await launchBrowser();
    const page    = await stealthPage(browser);
    try {
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=ae&hl=en&num=8`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1500);

        const results = await page.evaluate(() => {
            const organic  = [];
            const shopping = [];

            document.querySelectorAll('div.g, div[data-sokoban-container]').forEach(el => {
                const titleEl   = el.querySelector('h3');
                const linkEl    = el.querySelector('a[href]');
                const snippetEl = el.querySelector('div[data-sncf], .VwiC3b, span.st');
                if (titleEl && linkEl) {
                    organic.push({
                        title:   titleEl.textContent.trim(),
                        link:    linkEl.href,
                        snippet: snippetEl ? snippetEl.textContent.trim() : ''
                    });
                }
            });

            document.querySelectorAll('.sh-dgr__content, .mnr-c').forEach(el => {
                const titleEl = el.querySelector('.Lq5OHe, h3, [class*="title"]');
                const priceEl = el.querySelector('.a8Pemb, [class*="price"], .kHxwFf');
                const srcEl   = el.querySelector('.aULzUe, [class*="merchant"], [class*="source"]');
                if (titleEl && priceEl) {
                    shopping.push({
                        title:  titleEl.textContent.trim(),
                        price:  priceEl.textContent.trim(),
                        source: srcEl ? srcEl.textContent.trim() : ''
                    });
                }
            });

            return { organic_results: organic.slice(0, 6), shopping_results: shopping.slice(0, 5) };
        });

        return results;
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

// ── Dubizzle UAE ──────────────────────────────────────────────────────
async function scrapeDubizzle(query) {
    const browser = await launchBrowser();
    const page    = await stealthPage(browser);
    try {
        const url = `https://uae.dubizzle.com/search/?q=${encodeURIComponent(query)}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);

        const listings = await page.evaluate(() => {
            const results = [];
            const cards = document.querySelectorAll(
                '[class*="listing-card"], [class*="ListingCard"], ' +
                '[data-testid="listing-card"], article[class*="item"], ' +
                'li[class*="listing"], div[class*="product-item"]'
            );

            cards.forEach(card => {
                const titleEl = card.querySelector('h2, h3, [class*="title"], [class*="name"]');
                const priceEl = card.querySelector('[class*="price"], [class*="Price"], strong');
                const condEl  = card.querySelector('[class*="condition"], [class*="Condition"], [class*="badge"]');
                const linkEl  = card.querySelector('a[href]');
                if (!titleEl || !priceEl) return;
                const priceNum = parseInt(priceEl.textContent.replace(/[^0-9]/g, ''), 10);
                if (!priceNum || priceNum < 50 || priceNum > 500000) return;
                results.push({
                    title:     titleEl.textContent.trim().slice(0, 100),
                    price:     priceNum,
                    priceText: priceEl.textContent.trim(),
                    condition: condEl ? condEl.textContent.trim() : 'Used',
                    url:       linkEl ? linkEl.href : ''
                });
            });

            // Fallback: scan for AED prices if card parsing failed
            if (!results.length) {
                const matches = document.body.innerText.match(/AED\s*([\d,]+)/g) || [];
                matches.slice(0, 10).forEach(m => {
                    const num = parseInt(m.replace(/[^0-9]/g, ''), 10);
                    if (num >= 200 && num <= 500000) {
                        results.push({ title: '', price: num, priceText: m, condition: 'Used', url: '' });
                    }
                });
            }

            return results.slice(0, 8);
        });

        return listings;
    } catch {
        return [];
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

module.exports = { scrapeGoogleSearch, scrapeDubizzle };
