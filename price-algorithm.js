const HARD_TIER_WORDS = new Set([
    'ti', 'super', 'xt', 'xtx', 'gre', 'x3d', 'ultra'
]);

const GENERIC_WORDS = new Set([
    'a', 'an', 'and', 'for', 'with', 'the', 'gaming', 'graphics',
    'card', 'gpu', 'cpu', 'processor', 'desktop', 'pc', 'computer',
    'motherboard', 'board', 'monitor', 'display', 'ssd', 'nvme',
    'sata', 'ram', 'memory', 'ddr4', 'ddr5', 'case', 'tower',
    'cooler', 'cooling', 'fan', 'fans', 'psu', 'power', 'supply',
    'atx', 'wifi', 'wi', 'fi', 'version'
]);

const SOURCE_WEIGHTS = {
    'Microless': 1.0,
    'Amazon.ae': 0.82,
    'PCPartPicker': 0.35
};

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function roundPrice(n) {
    return Math.round(n);
}

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/×/g, 'x')
        .replace(/[^a-z0-9+.\- ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokensFor(value) {
    const normalized = normalizeText(value)
        .replace(/(\d+)\s*(gb|tb|mhz|hz|w)\b/g, '$1$2')
        .replace(/\bi\s*([3579])\s*[- ]\s*(\d{4,5}[a-z]*)\b/g, 'i$1-$2')
        .replace(/\b(core|ryzen|radeon|geforce|nvidia|amd|intel)\b/g, ' $1 ');

    return normalized.split(/\s+/).filter(Boolean);
}

function isModelToken(token) {
    if (/^\d{3,}[a-z0-9]*$/.test(token)) return true;
    if (/^[a-z]{1,4}\d{2,}[a-z0-9]*$/.test(token)) return true;
    if (/^i[3579]-\d{4,5}[a-z0-9]*$/.test(token)) return true;
    return false;
}

function isCapacityToken(token) {
    return /^\d+(?:gb|tb|mhz|hz|w)$/.test(token);
}

function importantTokens(productName) {
    const tokens = tokensFor(productName);
    const important = tokens.filter(token =>
        isModelToken(token) ||
        isCapacityToken(token) ||
        HARD_TIER_WORDS.has(token) ||
        (!GENERIC_WORDS.has(token) && token.length >= 3)
    );
    return [...new Set(important)];
}

function tokenSet(value) {
    return new Set(tokensFor(value));
}

function extractSameUnitTokens(tokens, unit) {
    return tokens.filter(token => token.endsWith(unit) && /^\d+/.test(token));
}

function hasCapacityMismatch(queryTokens, titleTokens) {
    for (const unit of ['gb', 'tb', 'mhz', 'hz', 'w']) {
        const query = extractSameUnitTokens(queryTokens, unit);
        if (!query.length) continue;

        const title = extractSameUnitTokens(titleTokens, unit);
        if (title.length && !query.some(token => title.includes(token))) return true;
    }
    return false;
}

function analyzeOfferMatch(product, offer) {
    const queryTokens = tokensFor(product.name);
    const titleTokens = tokensFor(offer.title || '');
    const titleSet = new Set(titleTokens);
    const keyTokens = importantTokens(product.name);
    const flags = [];

    if (!offer.price || offer.price < 100 || offer.price > 500000) {
        return { accepted: false, score: 0, flags: ['invalid-price'], keyTokens };
    }

    const requiredModelTokens = keyTokens.filter(token => isModelToken(token));
    const missingModelTokens = requiredModelTokens.filter(token => !titleSet.has(token));
    if (missingModelTokens.length) {
        return {
            accepted: false,
            score: 0,
            flags: [`missing-model:${missingModelTokens.join(',')}`],
            keyTokens
        };
    }

    const queryTierWords = queryTokens.filter(token => HARD_TIER_WORDS.has(token));
    const titleTierWords = titleTokens.filter(token => HARD_TIER_WORDS.has(token));
    const extraTierWords = titleTierWords.filter(token => !queryTierWords.includes(token));
    if (extraTierWords.length) {
        return {
            accepted: false,
            score: 0,
            flags: [`variant-tier-extra:${[...new Set(extraTierWords)].join(',')}`],
            keyTokens
        };
    }

    if (hasCapacityMismatch(queryTokens, titleTokens)) {
        return { accepted: false, score: 0, flags: ['capacity-mismatch'], keyTokens };
    }

    const matched = keyTokens.filter(token => titleSet.has(token));
    const coverage = keyTokens.length ? matched.length / keyTokens.length : 0.65;
    const modelCoverage = requiredModelTokens.length
        ? requiredModelTokens.filter(token => titleSet.has(token)).length / requiredModelTokens.length
        : 1;

    let score = clamp((coverage * 0.72) + (modelCoverage * 0.28), 0, 1);

    if (score < 0.45) flags.push('weak-title-match');
    if (offer.sponsored) {
        score *= 0.82;
        flags.push('sponsored');
    }

    return {
        accepted: score >= 0.35,
        score: Number(score.toFixed(3)),
        flags,
        keyTokens,
        matchedTokens: matched
    };
}

function sellerScoreFor(offer) {
    if (offer.source === 'Microless') return 0.98;

    const seller = normalizeText(offer.seller || '');
    const text = normalizeText(`${offer.title || ''} ${offer.badges || ''}`);

    if (seller.includes('amazon') || text.includes('fulfilled by amazon') || text.includes('ships from amazon')) {
        return 0.92;
    }
    if (offer.reviewCount >= 100 && offer.rating >= 4) return 0.78;
    if (offer.reviewCount >= 20 && offer.rating >= 3.8) return 0.70;
    return 0.58;
}

function stockScoreFor(offer) {
    if (offer.inStock === false) return 0.15;
    if (offer.inStock === true) return 1.0;
    return 0.72;
}

function anchorScoreFor(price, anchorPrice) {
    if (!anchorPrice) return { score: 1, flags: [] };

    const ratio = price / anchorPrice;
    const flags = [];
    let score = 1;

    if (ratio < 0.50) {
        score = 0.12;
        flags.push('scam-risk-too-cheap');
    } else if (ratio < 0.65) {
        score = 0.38;
        flags.push('below-anchor');
    } else if (ratio <= 1.35) {
        score = 1;
    } else if (ratio <= 1.65) {
        score = 0.72;
        flags.push('inflated');
    } else if (ratio <= 2.10) {
        score = 0.42;
        flags.push('heavily-inflated');
    } else {
        score = 0.16;
        flags.push('extreme-inflation');
    }

    return { score, flags, ratio };
}

function historyScoreFor(price, lastKnownPrice) {
    if (!lastKnownPrice || lastKnownPrice <= 0) return { score: 1, flags: [] };

    const change = Math.abs(price - lastKnownPrice) / lastKnownPrice;
    const flags = [];
    let score = 1;

    if (change <= 0.15) score = 1;
    else if (change <= 0.30) score = 0.82;
    else if (change <= 0.50) {
        score = 0.58;
        flags.push('large-price-move');
    } else {
        score = 0.32;
        flags.push('extreme-price-move');
    }

    return { score, flags, change };
}

function weightedQuantile(items, quantile) {
    const sorted = [...items].sort((a, b) => a.price - b.price);
    const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
    if (!sorted.length || totalWeight <= 0) return null;

    let cumulative = 0;
    for (const item of sorted) {
        cumulative += item.weight;
        if (cumulative / totalWeight >= quantile) return item.price;
    }
    return sorted[sorted.length - 1].price;
}

function weightedMean(items, valueKey = 'price') {
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    if (!items.length || totalWeight <= 0) return null;
    return items.reduce((sum, item) => sum + item[valueKey] * item.weight, 0) / totalWeight;
}

function scoreOffers(product, offers, anchorPrice, lastKnownPrice) {
    return offers.map((offer) => {
        const match = analyzeOfferMatch(product, offer);
        if (!match.accepted) {
            return {
                ...offer,
                accepted: false,
                weight: 0,
                matchScore: match.score,
                flags: match.flags
            };
        }

        const sourceWeight = SOURCE_WEIGHTS[offer.source] || 0.55;
        const sellerScore = sellerScoreFor(offer);
        const stockScore = stockScoreFor(offer);
        const anchor = anchorScoreFor(offer.price, anchorPrice);
        const history = historyScoreFor(offer.price, lastKnownPrice);
        const weight = sourceWeight * match.score * sellerScore * stockScore * anchor.score * history.score;

        return {
            ...offer,
            accepted: weight >= 0.08,
            weight: Number(weight.toFixed(4)),
            sourceWeight,
            matchScore: match.score,
            sellerScore,
            stockScore,
            anchorScore: anchor.score,
            historyScore: history.score,
            anchorRatio: anchor.ratio ? Number(anchor.ratio.toFixed(3)) : null,
            historyChange: history.change ? Number(history.change.toFixed(3)) : null,
            flags: [...match.flags, ...anchor.flags, ...history.flags]
        };
    });
}

function estimateFairPrice({ product, offers = [], anchorPrice = null, lastKnownPrice = null }) {
    const scoredOffers = scoreOffers(product, offers, anchorPrice, lastKnownPrice);
    const accepted = scoredOffers
        .filter(offer => offer.accepted && offer.price > 0 && offer.weight > 0)
        .sort((a, b) => a.price - b.price);

    if (!accepted.length && !anchorPrice) {
        return {
            price: 0,
            fairPrice: 0,
            status: 'manual_review',
            confidence: 0,
            source: 'No trusted price',
            band: null,
            offers: scoredOffers,
            notes: ['No accepted retailer offers and no reference anchor']
        };
    }

    if (!accepted.length && anchorPrice) {
        const anchor = roundPrice(anchorPrice);
        return {
            price: anchor,
            fairPrice: anchor,
            status: 'anchor_only',
            confidence: 35,
            source: 'PCPartPicker/manual anchor only',
            band: {
                low: roundPrice(anchor * 0.90),
                fair: anchor,
                high: roundPrice(anchor * 1.15)
            },
            offers: scoredOffers,
            notes: ['No accepted Microless or Amazon.ae offers; using anchor for review']
        };
    }

    const median = weightedQuantile(accepted, 0.50);
    const deviations = accepted.map(offer => ({
        price: Math.abs(offer.price - median),
        weight: offer.weight
    }));
    const mad = weightedQuantile(deviations, 0.50) || median * 0.12;
    const robustSpread = Math.max(median * 0.10, mad * 1.4826);

    let lower = median - (1.35 * robustSpread);
    let upper = median + (1.35 * robustSpread);

    if (anchorPrice) {
        lower = Math.max(lower, anchorPrice * 0.55);
        upper = Math.min(upper, anchorPrice * 1.85);
    }

    const winsorized = accepted.map(offer => ({
        ...offer,
        adjustedPrice: clamp(offer.price, lower, upper)
    }));

    const marketFair = weightedMean(winsorized, 'adjustedPrice');
    const totalWeight = accepted.reduce((sum, offer) => sum + offer.weight, 0);
    const sourceCount = new Set(accepted.map(offer => offer.source)).size;
    const riskFlags = accepted.flatMap(offer => offer.flags || [])
        .filter(flag => /scam|inflated|extreme|mismatch|weak|move/.test(flag));

    const anchorBlend = anchorPrice && (accepted.length < 2 || totalWeight < 1.2)
        ? 0.20
        : 0;
    const fair = anchorBlend
        ? ((marketFair * (1 - anchorBlend)) + (anchorPrice * anchorBlend))
        : marketFair;

    const matchQuality = weightedMean(accepted.map(offer => ({
        price: offer.matchScore,
        weight: offer.weight
    }))) || 0;

    const confidenceRaw =
        0.18 +
        (Math.min(accepted.length, 4) / 4) * 0.22 +
        (Math.min(sourceCount, 2) / 2) * 0.18 +
        clamp(totalWeight / 2.5, 0, 1) * 0.24 +
        matchQuality * 0.18 -
        Math.min(riskFlags.length * 0.055, 0.22) -
        anchorBlend * 0.18;

    const confidence = Math.round(clamp(confidenceRaw, 0, 1) * 100);
    const status = confidence >= 70 && riskFlags.length === 0
        ? 'trusted'
        : confidence >= 55
            ? 'watch'
            : 'manual_review';

    const low = weightedQuantile(accepted, 0.20) || fair * 0.92;
    const high = weightedQuantile(accepted, 0.80) || fair * 1.08;
    const source = accepted
        .map(offer => offer.source)
        .filter((sourceName, idx, arr) => arr.indexOf(sourceName) === idx)
        .join(' + ');

    return {
        price: roundPrice(fair),
        fairPrice: roundPrice(fair),
        status,
        confidence,
        source,
        band: {
            low: roundPrice(Math.min(low, fair)),
            fair: roundPrice(fair),
            high: roundPrice(Math.max(high, fair))
        },
        offers: scoredOffers,
        acceptedOffers: accepted,
        notes: [...new Set(riskFlags)]
    };
}

module.exports = {
    estimateFairPrice,
    scoreOffers,
    analyzeOfferMatch,
    importantTokens,
    normalizeText
};
