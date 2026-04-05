/**
 * pcpp.js — PCPartPicker helpers shared by server.js and gemini-tracker.js
 */
const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');

const PCPP_GITHUB_BASE = 'https://jonathanvusich.github.io/pcpartpicker-scraper';

const USD_TO_AED     = 3.67;
const PCPP_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const pcppCache      = {};

const CATEGORY_TO_PCPP = {
    'GPU':         'video-card',
    'CPU':         'cpu',
    'RAM':         'memory',
    'Motherboard': 'motherboard',
    'SSD':         'internal-hard-drive',
    'PSU':         'power-supply',
    'Case':        'case',
    'Cooler':      'cpu-cooler',
    'Fan':         'case-fan',
    'Monitor':     'monitor'
};

const PCPP_SUPPORTED_PARTS = [
    'cpu', 'cpu-cooler', 'motherboard', 'memory', 'internal-hard-drive',
    'video-card', 'power-supply', 'case', 'case-fan', 'fan-controller',
    'thermal-paste', 'optical-drive', 'sound-card', 'wired-network-card',
    'wireless-network-card', 'monitor', 'external-hard-drive', 'headphones',
    'keyboard', 'mouse', 'speakers', 'ups'
];

const PCPP_SUPPORTED_REGIONS = ['au','be','ca','de','es','fr','se','in','ie','it','nz','uk','us'];

async function scrapePcppLive(partSlug) {
    let browser;
    try {
        browser = await puppeteer.launch({
            args: [...chromium.args, '--disable-blink-features=AutomationControlled'],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.goto(`https://pcpartpicker.com/products/${partSlug}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise(r => setTimeout(r, 2000));

        const parts = await page.evaluate(() => {
            const rows = document.querySelectorAll('tr.tr__product');
            const results = [];
            for (const row of rows) {
                const nameEl  = row.querySelector('td.td__name p.search_results--link, td.td__name a');
                const priceEl = row.querySelector('td.td__price a, td.td__price');
                if (!nameEl || !priceEl) continue;
                const priceMatch = priceEl.textContent.match(/\$([\d,]+\.?\d*)/);
                if (!priceMatch) continue;
                const price = parseFloat(priceMatch[1].replace(/,/g, ''));
                if (!price || price <= 0) continue;
                results.push({ name: nameEl.textContent.trim(), price });
            }
            return results;
        });

        if (parts.length > 0) return parts;
        throw new Error('No products found via Puppeteer');
    } finally {
        if (browser) await browser.close();
    }
}

async function fetchPcppParts(partSlug) {
    const cached = pcppCache[partSlug];
    if (cached && (Date.now() - cached.fetchedAt) < PCPP_CACHE_TTL) {
        return cached.parts;
    }

    // Primary: GitHub Pages static JSON (fast, no browser)
    try {
        const res = await fetch(`${PCPP_GITHUB_BASE}/us/${partSlug}`);
        if (res.ok) {
            const html  = await res.text();
            const match = html.match(/\[[\s\S]*\]/);
            if (match) {
                const raw   = JSON.parse(match[0]);
                const parts = raw
                    .filter(p => p.price)
                    .map(p => ({
                        name:  `${p.brand || ''} ${p.model || ''} ${p.chipset || ''}`.trim(),
                        price: parseFloat(Array.isArray(p.price) ? p.price[0] : p.price)
                    }))
                    .filter(p => p.price > 0);
                if (parts.length > 0) {
                    pcppCache[partSlug] = { parts, fetchedAt: Date.now() };
                    return parts;
                }
            }
        }
    } catch {}

    // Fallback: live Puppeteer scrape
    console.log(`[PCPP] GitHub Pages failed for '${partSlug}', scraping live…`);
    const parts = await scrapePcppLive(partSlug);
    pcppCache[partSlug] = { parts, fetchedAt: Date.now() };
    return parts;
}

// Find closest match and return USD price + AED equivalent
async function getPcppReference(productName, category) {
    const partSlug = CATEGORY_TO_PCPP[category];
    if (!partSlug) return null;
    try {
        const parts  = await fetchPcppParts(partSlug);
        const tokens = productName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
        let best = null, bestScore = 0;
        for (const p of parts) {
            const label = p.name.toLowerCase();
            const score = tokens.filter(t => label.includes(t)).length;
            if (score > bestScore) { bestScore = score; best = p; }
        }
        if (!best || bestScore < 2) return null;
        const aedEquiv = Math.round(best.price * USD_TO_AED);
        return { label: best.name, usdPrice: best.price, aedEquiv };
    } catch {
        return null;
    }
}

// Get AED price from PCPartPicker for use in the price tracker
async function getPcppPrice(productName, category) {
    const ref = await getPcppReference(productName, category);
    if (!ref) throw new Error(`No PCPartPicker match for '${productName}'`);
    return { price: ref.aedEquiv, source: `PCPartPicker (US $${ref.usdPrice} → AED)` };
}

module.exports = {
    fetchPcppParts,
    getPcppReference,
    getPcppPrice,
    CATEGORY_TO_PCPP,
    PCPP_SUPPORTED_PARTS,
    PCPP_SUPPORTED_REGIONS,
    USD_TO_AED,
};
