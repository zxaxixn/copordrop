/**
 * Compatibility wrapper for older imports.
 *
 * The active tracker uses retailer-pricer.js + price-algorithm.js. This file is
 * kept so older code that imports scraper-engine.js does not load missing
 * puppeteer-extra dependencies.
 */
const {
    launchRetailBrowser,
    getRetailOffers,
    scrapeMicroless: scrapeMicrolessOffers,
    scrapeAmazonAE: scrapeAmazonOffers
} = require('./retailer-pricer');
const { estimateFairPrice } = require('./price-algorithm');

function asProduct(input, category = 'Other') {
    if (typeof input === 'object' && input) return input;
    return { name: String(input || ''), category };
}

async function scrapeMicroless(browser, query) {
    return scrapeMicrolessOffers(browser, asProduct(query));
}

async function scrapeAmazonAE(browser, query) {
    return scrapeAmazonOffers(browser, asProduct(query));
}

async function scrapeUAEPrice(browser, productName, options = {}) {
    const product = asProduct(productName, options.category || 'Other');
    const retail = await getRetailOffers(browser, product);
    const result = estimateFairPrice({
        product,
        offers: retail.offers,
        anchorPrice: options.anchorPrice || null,
        lastKnownPrice: options.lastKnownPrice || null
    });

    if (!result.price) throw new Error(result.notes?.join(', ') || 'No trusted UAE price found');
    return {
        price: result.price,
        source: result.source,
        confidence: result.confidence,
        status: result.status,
        band: result.band,
        offers: result.offers
    };
}

module.exports = {
    launchStealthBrowser: launchRetailBrowser,
    launchRetailBrowser,
    scrapeUAEPrice,
    scrapeMicroless,
    scrapeAmazonAE
};
