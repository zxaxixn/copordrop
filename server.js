require('dotenv').config();
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const cron      = require('node-cron');
const { fetchPcppParts, getPcppReference, PCPP_SUPPORTED_PARTS, PCPP_SUPPORTED_REGIONS, USD_TO_AED } = require('./pcpp');
const { trackAllPrices }                   = require('./gemini-tracker');
const { scrapeGoogleSearch, scrapeDubizzle } = require('./scrapers');
const { readDB, writeDB, initMongo }         = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Config ──────────────────────────────────────────────
const ADMIN_PASSWORD       = process.env.ADMIN_PASSWORD;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const AMAZON_AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || '';
const DB_FILE              = path.join(__dirname, 'db.json'); // kept for reference, actual DB is in db.js

// ── Startup env validation ───────────────────────────────
{
    const missing = ['ADMIN_PASSWORD', 'ANTHROPIC_API_KEY'].filter(k => !process.env[k]);
    if (missing.length) {
        console.warn(`⚠️  Missing env vars: ${missing.join(', ')} — some features will not work`);
    }
    if (!AMAZON_AFFILIATE_TAG) {
        console.warn('⚠️  AMAZON_AFFILIATE_TAG not set — Amazon links will not include affiliate tag');
    }
}

const ADMIN_TOKEN = ADMIN_PASSWORD
    ? crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex')
    : '';

// DB helpers imported from db.js — initMongo() called at server start below

// ── Auth middleware ───────────────────────────────────────
function authRequired(req, res, next) {
    if (req.headers['x-admin-token'] === ADMIN_TOKEN) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ── Public: get all products with a valid price, newest first ──
app.get('/api/products', (req, res) => {
    const products = readDB().products
        .filter(p => p.price > 0)
        .sort((a, b) => (a.releaseOrder ?? 999) - (b.releaseOrder ?? 999));
    res.json(products);
});

// ── Admin: login ─────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        res.json({ token: ADMIN_TOKEN });
    } else {
        res.status(401).json({ error: 'Wrong password' });
    }
});

// ── Admin: CRUD ───────────────────────────────────────────
app.get('/api/admin/products', authRequired, (req, res) => {
    const products = readDB().products
        .sort((a, b) => (a.releaseOrder ?? 999) - (b.releaseOrder ?? 999));
    res.json(products);
});

app.post('/api/admin/products', authRequired, (req, res) => {
    const { name, category, price, checkedAt } = req.body;
    if (!name || !category || price === undefined) {
        return res.status(400).json({ error: 'name, category, and price are required' });
    }
    const db = readDB();
    const product = {
        id:        Date.now().toString(),
        name:      name.trim(),
        category:  category.trim(),
        price:     Number(price),
        checkedAt: checkedAt || new Date().toISOString()
    };
    db.products.push(product);
    writeDB(db);
    res.json(product);
});

app.put('/api/admin/products/:id', authRequired, (req, res) => {
    const db  = readDB();
    const idx = db.products.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const { name, category, price, checkedAt } = req.body;
    if (name      !== undefined) db.products[idx].name      = name.trim();
    if (category  !== undefined) db.products[idx].category  = category.trim();
    if (price     !== undefined) db.products[idx].price     = Number(price);
    if (checkedAt !== undefined) db.products[idx].checkedAt = checkedAt;
    writeDB(db);
    res.json(db.products[idx]);
});

app.delete('/api/admin/products/:id', authRequired, (req, res) => {
    const db = readDB();
    db.products = db.products.filter(p => p.id !== req.params.id);
    writeDB(db);
    res.json({ ok: true });
});

// ── Public config (affiliate tag etc.) ──────────────────
app.get('/api/config', (req, res) => {
    res.json({ amazonTag: AMAZON_AFFILIATE_TAG });
});

// ── Recent verdicts ───────────────────────────────────────
app.get('/api/verdicts', (req, res) => {
    const db = readDB();
    const verdicts = (db.verdicts || []).slice(-6).reverse();
    res.json(verdicts);
});

app.post('/api/verdicts', (req, res) => {
    const { type, title, summary } = req.body;
    if (!type || !title) return res.status(400).json({ error: 'type and title required' });
    const db = readDB();
    if (!db.verdicts) db.verdicts = [];
    db.verdicts.push({
        id:        Date.now().toString(),
        type:      ['cop', 'drop', 'scam'].includes(type) ? type : 'drop',
        title:     String(title).slice(0, 80),
        summary:   String(summary || '').slice(0, 200),
        checkedAt: new Date().toISOString()
    });
    // Keep last 50
    if (db.verdicts.length > 50) db.verdicts = db.verdicts.slice(-50);
    writeDB(db);
    res.json({ ok: true });
});

// ── Google search proxy (replaces SerpAPI) ───────────────
app.get('/api/search', async (req, res) => {
    try {
        const results = await scrapeGoogleSearch(req.query.q || '');
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message, organic_results: [], shopping_results: [] });
    }
});

// ── Dubizzle used listings ────────────────────────────────
app.post('/api/dubizzle', async (req, res) => {
    try {
        const listings = await scrapeDubizzle(req.body.query || '');
        res.json(listings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Claude proxy ──────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: {
                'x-api-key':         ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type':      'application/json'
            },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── Price history: get ─────────────────────────────────────
app.get('/api/products/:id/history', (req, res) => {
    const db = readDB();
    const history = (db.priceHistory || {})[req.params.id] || [];
    res.json(history);
});

// ── Price history: add entry (admin) ──────────────────────
app.post('/api/products/:id/history', authRequired, (req, res) => {
    const { price, date } = req.body;
    if (price === undefined) return res.status(400).json({ error: 'price required' });
    const db = readDB();
    if (!db.priceHistory) db.priceHistory = {};
    if (!db.priceHistory[req.params.id]) db.priceHistory[req.params.id] = [];
    const dateStr = date || new Date().toISOString().slice(0, 10);
    const existing = db.priceHistory[req.params.id].findIndex(e => e.date === dateStr);
    if (existing >= 0) {
        db.priceHistory[req.params.id][existing].price = Number(price);
    } else {
        db.priceHistory[req.params.id].push({ price: Number(price), date: dateStr });
    }
    db.priceHistory[req.params.id].sort((a, b) => a.date.localeCompare(b.date));
    writeDB(db);
    res.json({ ok: true });
});

// ── AI price prediction via Claude ────────────────────────
app.post('/api/products/:id/predict', async (req, res) => {
    const db = readDB();
    const product = db.products.find(p => p.id === req.params.id);
    if (!product) return res.status(404).json({ error: 'Not found' });
    const history = (db.priceHistory || {})[req.params.id] || [];

    const historyText = history.length > 0
        ? history.map(h => `${h.date}: AED ${h.price}`).join('\n')
        : `Current price only: AED ${product.price}`;

    const ref = await getPcppReference(product.name, product.category);
    let refText = '';
    if (ref) {
        const margin = product.price > 0
            ? Math.round(((product.price - ref.aedEquiv) / ref.aedEquiv) * 100)
            : null;
        refText = `\nGlobal reference (PCPartPicker US): ${ref.label} — $${ref.usdPrice} USD = AED ${ref.aedEquiv} at pegged rate (1 USD = 3.67 AED)` +
                  (margin !== null ? `\nUAE premium over US price: ${margin > 0 ? '+' : ''}${margin}% (normal import margin is ~10–20%)` : '');
    }

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key':         ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type':      'application/json'
            },
            body: JSON.stringify({
                model:      'claude-sonnet-4-6',
                max_tokens: 400,
                system:     'You are a UAE PC hardware market analyst. Your job is to always output a price prediction in JSON — never refuse, never add disclaimers, never say you need more data. Even with a single price point, use your knowledge of current market conditions: US-China trade tensions, US tariffs on electronics, semiconductor supply chains, GPU demand cycles, USD/AED stability, and regional UAE pricing trends. Always commit to a direction. Always output valid JSON and nothing else.',
                messages: [{
                    role: 'user',
                    content: `Product: ${product.name} (Category: ${product.category})\n\nUAE Price History (AED):\n${historyText}${refText}\n\nBased on this data and your knowledge of current real-world market conditions (tariffs, geopolitics, supply/demand, GPU market trends), predict whether this product's UAE price will go UP, DOWN, or stay FLAT in the next 2–4 weeks.\n\nYou MUST reply with ONLY this exact JSON format (no markdown, no extra text, no refusals):\n{"direction":"UP","confidence":"LOW","summary":"one sentence prediction","factors":["factor 1","factor 2","factor 3"]}`
                }]
            })
        });
        const data = await response.json();
        if (data.error) return res.status(500).json({ error: data.error.message });
        let text = data.content[0].text.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '');
        res.json(JSON.parse(text));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PCPartPicker helpers imported from pcpp.js ───────────

app.get('/api/pcpartpicker/:part', async (req, res) => {
    const part   = req.params.part;
    const region = (req.query.region || 'us').toLowerCase();

    if (!PCPP_SUPPORTED_PARTS.includes(part))
        return res.status(400).json({ error: `Unsupported part '${part}'. Supported: ${PCPP_SUPPORTED_PARTS.join(', ')}` });
    if (!PCPP_SUPPORTED_REGIONS.includes(region))
        return res.status(400).json({ error: `Unsupported region '${region}'. Supported: ${PCPP_SUPPORTED_REGIONS.join(', ')}` });

    try {
        const parts = await fetchPcppParts(part);
        res.json({ part, region, count: parts.length, data: parts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/pcpartpicker', (req, res) => {
    res.json({ supported_parts: PCPP_SUPPORTED_PARTS, supported_regions: PCPP_SUPPORTED_REGIONS });
});

// ── Admin panel ───────────────────────────────────────────
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ── Admin: manual price tracking trigger ─────────────────
app.post('/api/admin/track-prices', authRequired, (req, res) => {
    res.json({ ok: true, message: 'Price tracking started in background' });
    trackAllPrices().catch(console.error);
});

// ── Daily Gemini price tracker — 6:00 AM UAE time (02:00 UTC) ──
cron.schedule('0 2 * * *', () => {
    console.log('[CRON] Running daily Gemini price tracker...');
    trackAllPrices().catch(console.error);
}, { timezone: 'UTC' });

const PORT = process.env.PORT || 3000;
initMongo().then(() => {
    app.listen(PORT, () => console.log(`CopOrDrop server → http://localhost:${PORT}`));
}).catch(err => {
    console.error('Failed to init DB:', err.message);
    process.exit(1);
});
