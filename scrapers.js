/**
 * scrapers.js — shared Puppeteer scrapers used by the server
 * • scrapeGoogleSearch(query)  — replaces SerpAPI for cop/drop web search
 * • scrapeDubizzle(query)      — returns used UAE listings from Dubizzle
 */
const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function launchBrowser() {
    return puppeteer.launch({
        args: [...chromium.args, '--disable-blink-features=AutomationControlled', '--window-size=1366,768'],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
    });
}

async function stealthPage(browser) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AE,en;q=0.9' });
    return page;
}

// ── Google Search — returns SerpAPI-compatible format ─────────────
async function scrapeGoogleSearch(query) {
    const browser = await launchBrowser();
    const page    = await stealthPage(browser);
    try {
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=ae&hl=en&num=8`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(1500);

        const results = await page.evaluate(() => {
            const organic  = [];
            const shopping = [];

            // Organic results
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

            // Shopping results
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
        await page.close();
        await browser.close();
    }
}

// ── Dubizzle UAE — returns used listings with prices ──────────────
async function scrapeDubizzle(query) {
    const browser = await launchBrowser();
    const page    = await stealthPage(browser);
    try {
        const url = `https://uae.dubizzle.com/search/?q=${encodeURIComponent(query)}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
        await sleep(2500);

        const listings = await page.evaluate(() => {
            const results = [];
            // Dubizzle listing cards — try multiple selector patterns
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

                const priceText = priceEl.textContent.trim();
                const priceNum  = parseInt(priceText.replace(/[^0-9]/g, ''), 10);
                if (!priceNum || priceNum < 50 || priceNum > 500000) return;

                results.push({
                    title:     titleEl.textContent.trim().slice(0, 100),
                    price:     priceNum,
                    priceText: priceText,
                    condition: condEl ? condEl.textContent.trim() : 'Used',
                    url:       linkEl ? linkEl.href : ''
                });
            });

            // Fallback: scan page for price patterns if card parsing failed
            if (!results.length) {
                const allText = document.body.innerText;
                const priceMatches = allText.match(/AED\s*([\d,]+)/g) || [];
                priceMatches.slice(0, 10).forEach(m => {
                    const num = parseInt(m.replace(/[^0-9]/g, ''), 10);
                    if (num >= 200 && num <= 500000) {
                        results.push({ title: query, price: num, priceText: m, condition: 'Used', url: '' });
                    }
                });
            }

            return results.slice(0, 8);
        });

        return listings;
    } catch (e) {
        return [];
    } finally {
        await page.close();
        await browser.close();
    }
}

module.exports = { scrapeGoogleSearch, scrapeDubizzle };
