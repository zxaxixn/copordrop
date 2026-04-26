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

function trimTitle(title) {
    const clean = String(title || '').replace(/\s+/g, ' ').trim();
    return clean.length > 90 ? `${clean.slice(0, 87)}...` : clean;
}

function describeOffer(offer) {
    const flags = (offer.flags || []).length ? offer.flags.join('|') : 'no-flags';
    const price = offer.price ? `AED ${Number(offer.price).toLocaleString()}` : 'no-price';
    return `${offer.source} ${price} "${trimTitle(offer.title)}" -> ${flags}`;
}

function offerDiagnostics(result, limit = 5) {
    const offers = result.offers || [];
    const accepted = offers.filter(offer => offer.accepted);
    const rejected = offers.filter(offer => !offer.accepted);

    return {
        accepted: accepted.slice(0, limit).map(describeOffer),
        rejected: rejected
            .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))
            .slice(0, limit)
            .map(describeOffer)
    };
}

function logOfferDiagnostics(result) {
    const diagnostics = offerDiagnostics(result, 4);
    if (diagnostics.accepted.length) {
        console.log('      accepted sample:');
        diagnostics.accepted.forEach(line => console.log(`        ${line}`));
    }
    if (diagnostics.rejected.length) {
        console.log('      rejected sample:');
        diagnostics.rejected.forEach(line => console.log(`        ${line}`));
    }
}

function failureMessage(result) {
    const notes = result.notes?.length
        ? result.notes.join(', ')
        : 'No trusted Microless/Amazon.ae price found';
    const rejected = offerDiagnostics(result, 3).rejected;
    return rejected.length ? `${notes}; rejected: ${rejected.join(' | ')}` : notes;
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
                result.sourceErrors = sourceErrors;

                if (!result.price) {
                    logOfferDiagnostics(result);
                    throw new Error(failureMessage(result));
                }

                if (result.status === 'manual_review') {
                    logOfferDiagnostics(result);
                    if (result.acceptedOffers?.length) {
                        result.status = 'watch';
                        result.confidence = Math.max(result.confidence, 45);
                        result.notes = [...new Set([...(result.notes || []), 'low-confidence-retailer-price'])];
                        console.log('      low confidence accepted offers - saving as watch');
                    } else {
                        throw new Error(failureMessage(result));
                    }
                }

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
