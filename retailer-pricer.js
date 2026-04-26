const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePrice(value) {
    const cleaned = String(value || '').replace(/,/g, '').replace(/[^\d.]/g, '');
    const price = Number.parseFloat(cleaned);
    if (!Number.isFinite(price) || price < 100 || price > 500000) return null;
    return Math.round(price);
}

function dedupeOffers(offers) {
    const byKey = new Map();
    for (const offer of offers) {
        if (!offer.price || !offer.title) continue;
        const key = `${offer.source}:${offer.url || offer.title}`.toLowerCase();
        const existing = byKey.get(key);
        if (!existing || offer.price < existing.price) byKey.set(key, offer);
    }
    return [...byKey.values()];
}

async function launchRetailBrowser() {
    return puppeteer.launch({
        args: [
            ...chromium.args,
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--window-size=1366,900'
        ],
        defaultViewport: { width: 1366, height: 900 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true
    });
}

async function newRetailPage(browser) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-AE', 'en'] });
        window.chrome = { runtime: {} };
    });
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AE,en;q=0.9' });
    return page;
}

async function scrapeMicroless(browser, product) {
    const page = await newRetailPage(browser);
    try {
        const url = `https://www.microless.com/search/?q=${encodeURIComponent(product.name)}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(2500);

        const offers = await page.evaluate(() => {
            function parsePrice(text) {
                const patterns = [
                    /AED\s*([\d,]+(?:\.\d{1,2})?)/i,
                    /([\d,]+(?:\.\d{1,2})?)\s*AED/i,
                    /د\.إ\s*([\d,]+(?:\.\d{1,2})?)/i
                ];
                for (const pattern of patterns) {
                    const match = text.match(pattern);
                    if (match) return Math.round(Number(match[1].replace(/,/g, '')));
                }
                return null;
            }

            function bestCardFor(anchor) {
                return anchor.closest('.product, .product-item, .product-grid-item, li, article, [class*="product"]')
                    || anchor.parentElement;
            }

            const results = [];
            const anchors = Array.from(document.querySelectorAll('a[href*="/product"], a[href*="/en/product"]'));
            for (const anchor of anchors) {
                const card = bestCardFor(anchor);
                if (!card) continue;

                const text = card.innerText || anchor.innerText || '';
                const title =
                    anchor.getAttribute('title') ||
                    anchor.innerText ||
                    card.querySelector('[class*="title"], h2, h3, h4')?.innerText ||
                    '';
                const price = parsePrice(text);
                if (!price || price < 100 || price > 500000) continue;

                results.push({
                    source: 'Microless',
                    title: title.replace(/\s+/g, ' ').trim(),
                    price,
                    url: anchor.href,
                    seller: 'Microless',
                    inStock: !/out of stock|sold out|unavailable/i.test(text),
                    badges: text.slice(0, 500)
                });
            }
            return results;
        });

        return dedupeOffers(offers).slice(0, 12);
    } finally {
        await page.close().catch(() => {});
    }
}

async function scrapeAmazonAE(browser, product) {
    const page = await newRetailPage(browser);
    try {
        const url = `https://www.amazon.ae/s?k=${encodeURIComponent(product.name)}&i=electronics`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(2500);

        const captcha = await page.$('form[action*="validateCaptcha"], #captchacharacters');
        if (captcha) throw new Error('Amazon CAPTCHA detected');

        const offers = await page.evaluate(() => {
            function priceFromItem(item) {
                const offscreen = item.querySelector('.a-price .a-offscreen');
                if (offscreen) {
                    const n = Number.parseFloat(offscreen.textContent.replace(/,/g, '').replace(/[^\d.]/g, ''));
                    if (Number.isFinite(n)) return Math.round(n);
                }

                const whole = item.querySelector('.a-price-whole')?.textContent || '';
                const fraction = item.querySelector('.a-price-fraction')?.textContent || '00';
                const n = Number.parseFloat(`${whole.replace(/[^\d]/g, '')}.${fraction.replace(/[^\d]/g, '')}`);
                return Number.isFinite(n) ? Math.round(n) : null;
            }

            function parseRating(text) {
                const match = String(text || '').match(/([\d.]+)\s*out of/i);
                return match ? Number.parseFloat(match[1]) : null;
            }

            function parseReviews(text) {
                const match = String(text || '').replace(/,/g, '').match(/\b(\d{1,7})\b/);
                return match ? Number.parseInt(match[1], 10) : 0;
            }

            const results = [];
            const items = Array.from(document.querySelectorAll('[data-component-type="s-search-result"]'));
            for (const item of items) {
                const text = item.innerText || '';
                const sponsored = /sponsored/i.test(text) || !!item.querySelector('.puis-sponsored-label-text');
                if (sponsored) continue;

                const titleEl = item.querySelector('h2 span, h2 a span, [data-cy="title-recipe"] span');
                const linkEl = item.querySelector('h2 a, a.a-link-normal.s-no-outline');
                const price = priceFromItem(item);
                const title = titleEl?.textContent?.replace(/\s+/g, ' ').trim() || '';
                if (!title || !price || price < 100 || price > 500000) continue;

                const ratingText = item.querySelector('.a-icon-alt')?.textContent || '';
                const reviewsText = item.querySelector('[aria-label$="ratings"], [aria-label$="rating"], .s-underline-text')?.textContent || '';
                const prime = /prime/i.test(text);

                results.push({
                    source: 'Amazon.ae',
                    title,
                    price,
                    url: linkEl ? new URL(linkEl.getAttribute('href'), location.origin).href : '',
                    seller: prime ? 'Amazon/Prime result' : '',
                    rating: parseRating(ratingText),
                    reviewCount: parseReviews(reviewsText),
                    inStock: !/currently unavailable|out of stock/i.test(text),
                    sponsored: false,
                    badges: text.slice(0, 500)
                });
            }
            return results;
        });

        return dedupeOffers(offers).slice(0, 12);
    } finally {
        await page.close().catch(() => {});
    }
}

async function getRetailOffers(browser, product) {
    const sources = [
        { name: 'Microless', fn: () => scrapeMicroless(browser, product) },
        { name: 'Amazon.ae', fn: () => scrapeAmazonAE(browser, product) }
    ];

    const offers = [];
    const errors = [];

    for (const source of sources) {
        try {
            const sourceOffers = await source.fn();
            offers.push(...sourceOffers);
            console.log(`      ${source.name}: ${sourceOffers.length} offer(s)`);
        } catch (e) {
            errors.push({ source: source.name, error: e.message });
            console.log(`      ${source.name}: ${e.message}`);
        }
        await sleep(900);
    }

    return {
        offers: dedupeOffers(offers),
        errors
    };
}

module.exports = {
    launchRetailBrowser,
    getRetailOffers,
    scrapeMicroless,
    scrapeAmazonAE,
    normalizePrice
};
