/**
 * db.js — Shared database module
 * - Synchronous readDB()/writeDB() API so existing code needs zero changes
 * - Writes to db.json locally (backup) AND MongoDB (production persistence)
 * - On startup, initMongo() loads data from MongoDB into the in-memory cache
 * - Works with or without MONGODB_URI — falls back to file-only if not set
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');
let cache     = null;
let mongoCol  = null;

// ── File helpers ─────────────────────────────────────────
function readFile() {
    try {
        if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {}
    return { products: [], priceHistory: {}, verdicts: [] };
}

function writeFile(data) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) {
        console.error('[DB] File write failed:', e.message);
    }
}

// ── MongoDB (async, background) ───────────────────────────
async function persistToMongo(data) {
    if (!mongoCol) return;
    try {
        await mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', ...data }, { upsert: true });
    } catch (e) {
        console.error('[DB] MongoDB write failed:', e.message);
    }
}

async function initMongo() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.log('[DB] No MONGODB_URI — using local db.json only');
        cache = readFile();
        return;
    }
    try {
        const { MongoClient } = require('mongodb');
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
        await client.connect();
        const db = client.db('copordrip');
        mongoCol = db.collection('state');
        console.log('[DB] MongoDB connected');

        // Load from MongoDB into cache (overrides local file)
        const doc = await mongoCol.findOne({ _id: 'main' });
        if (doc) {
            const { _id, ...data } = doc;
            cache = data;
            writeFile(cache); // keep local file in sync
            console.log(`[DB] Loaded from MongoDB — ${(cache.products || []).length} products`);
        } else {
            // First deploy: seed MongoDB from local file if it has data
            cache = readFile();
            if ((cache.products || []).length > 0) {
                await persistToMongo(cache);
                console.log('[DB] Seeded MongoDB from local db.json');
            }
        }
    } catch (e) {
        console.warn('[DB] MongoDB connection failed:', e.message, '— falling back to db.json');
        cache = readFile();
    }
}

// ── Public API ────────────────────────────────────────────
function readDB() {
    if (!cache) cache = readFile();
    return cache;
}

function writeDB(data) {
    cache = data;
    writeFile(data);
    persistToMongo(data); // fire-and-forget
}

module.exports = { readDB, writeDB, initMongo };
