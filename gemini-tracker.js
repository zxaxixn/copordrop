require('dotenv').config();
const { getPcppReference } = require('./pcpp');
const { readDB, writeDB } = require('./db');
const { launchRetailBrowser, getRetailOffers } = require('./retailer-pricer');
const { estimateFairPrice } = require('./price-algorithm');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(promise, ms, label) {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s for: ${label}`)), ms)
    );
    return Promise.race([promise, timeout]);
}

let isTracking = false;
let cancelRequested = false;

function cancelTracking() {
    if (isTracking) {
        cancelRequested = true;
        console.log('[Tracker] Cancel requested - will stop after current product.');
    }
}

// Generate weekly price history from Jan 5 2026 to yesterday using current price as baseline.
function backfillHistory(price) {
    const history = [];
    const start   = new Date('2026-01-05');
    const end     = new Date();
    end.setDate(end.getDate() - 1);

    const current = new Date(start);
    while (current <= end) {
        history.push({ date: current.toISOString().slice(0, 10), price });
        current.setDate(current.getDate() + 7);
    }
    return history;
}

function compactOffer(offer) {
    return {
        source: offer.source,
        title: offer.title,
        price: offer.price,
        url: offer.url,
        seller: offer.seller || '',
        accepted: Boolean(offer.accepted),
        weight: offer.weight || 0,
        matchScore: offer.matchScore || 0,
        anchorRatio: offer.anchorRatio || null,
        flags: offer.flags || []
    };
}

function lastKnownPriceFor(db, productId) {
    const history = (db.priceHistory || {})[productId] || [];
    const last = history[history.length - 1];
    return last?.price || null;
}

function applyPriceResult(product, result, msrpRef) {
    product.price           = result.price;
    product.fairPrice       = result.fairPrice;
    product.lowTrustedPrice = result.band?.low || null;
    product.highTrustedPrice = result.band?.high || null;
    product.priceConfidence = result.confidence;
    product.priceStatus     = result.status;
    product.priceSource     = result.source;
    product.priceNotes      = result.notes || [];
    product.priceSourceErrors = result.sourceErrors || [];
    product.priceOffers     = (result.offers || []).map(compactOffer).slice(0, 10);
    product.checkedAt       = new Date().toISOString();

    if (msrpRef) {
        product.pcppAnchor = {
            label: msrpRef.label,
            usdPrice: msrpRef.usdPrice,
            aedEquiv: msrpRef.aedEquiv,
            checkedAt: product.checkedAt
        };
    }
}

async function trackAllPrices(singleProductId = null) {
    if (isTracking) {
        console.log('[Tracker] Already running, skipping.');
        return { updated: 0, total: 0, errors: [], skipped: true };
    }

    const db    = readDB();
    const today = new Date().toISOString().slice(0, 10);
    let updated = 0;
    const errors = [];

    const products = singleProductId
        ? db.products.filter(p => p.id === singleProductId)
        : db.products;

    if (singleProductId && !products.length) {
        return { updated: 0, total: 0, errors: [{ product: singleProductId, error: 'Product not found' }] };
    }

    isTracking = true;
    cancelRequested = false;

    console.log(`[${new Date().toISOString()}] Price tracker - ${products.length} product(s)`);
    console.log('  Sources: Microless + Amazon.ae, with PCPartPicker/manual anchors for validation');

    let browser = null;
    try {
        try {
            browser = await launchRetailBrowser();
        } catch (e) {
            console.log(`[Tracker] Retail browser unavailable: ${e.message}`);
        }

        for (const product of products) {
            console.log(`  -> ${product.name}`);
            try {
                let msrpRef = null;
                try {
                    msrpRef = await withTimeout(
                        getPcppReference(product.name, product.category),
                        20000,
                        `PCPartPicker:${product.name}`
                    );
                    if (msrpRef) {
                        console.log(`      anchor: AED ${msrpRef.aedEquiv.toLocaleString()} (${msrpRef.label})`);
                    }
                } catch (e) {
                    console.log(`      anchor: ${e.message}`);
                }

                let offers = [];
                let sourceErrors = [];
                if (browser) {
                    try {
                        const retail = await withTimeout(
                            getRetailOffers(browser, product),
                            100000,
                            `retail:${product.name}`
                        );
                        offers = retail.offers;
                        sourceErrors = retail.errors;
                    } catch (e) {
                        sourceErrors.push({ source: 'retail', error: e.message });
                        console.log(`      retail: ${e.message}`);
                    }
                }

                const anchorPrice = product.manualMsrp || (msrpRef ? msrpRef.aedEquiv : null);
                const result = estimateFairPrice({
                    product,
                    offers,
                    anchorPrice,
                    lastKnownPrice: lastKnownPriceFor(db, product.id)
                });

                if (!result.price || result.status === 'manual_review') {
                    throw new Error(
                        result.notes?.length
                            ? result.notes.join(', ')
                            : 'No trusted Microless/Amazon.ae price found'
                    );
                }

                result.sourceErrors = sourceErrors;

                if (!db.priceHistory) db.priceHistory = {};
                if (!db.priceHistory[product.id]) db.priceHistory[product.id] = [];

                applyPriceResult(product, result, msrpRef);

                if (db.priceHistory[product.id].length === 0) {
                    db.priceHistory[product.id] = backfillHistory(result.price);
                    console.log('      backfilled history from Jan 5');
                }

                const entry = {
                    date: today,
                    price: result.price,
                    confidence: result.confidence,
                    status: result.status
                };
                const existing = db.priceHistory[product.id].findIndex(e => e.date === today);
                if (existing >= 0) {
                    db.priceHistory[product.id][existing] = {
                        ...db.priceHistory[product.id][existing],
                        ...entry
                    };
                } else {
                    db.priceHistory[product.id].push(entry);
                }
                db.priceHistory[product.id].sort((a, b) => a.date.localeCompare(b.date));

                console.log(
                    `      price: AED ${result.price.toLocaleString()} ` +
                    `(${result.source}, ${result.confidence}% confidence, ${result.status})`
                );
                updated++;
                writeDB(db);
            } catch (e) {
                console.log(`      FAILED - ${e.message}`);
                errors.push({ product: product.name, error: e.message });
            }

            await sleep(1500);

            if (cancelRequested) {
                console.log('[Tracker] Cancelled by user.');
                break;
            }
        }
    } finally {
        if (browser) await browser.close().catch(() => {});
        isTracking = false;
        cancelRequested = false;
    }

    console.log(`\nDone. ${updated}/${products.length} updated.\n`);
    return { updated, total: products.length, errors };
}

if (require.main === module) {
    trackAllPrices().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = {
    trackAllPrices,
    trackProduct: (id) => trackAllPrices(id),
    cancelTracking,
    getTrackingStatus: () => ({ isTracking, cancelRequested })
};
