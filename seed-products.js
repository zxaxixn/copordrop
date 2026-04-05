/**
 * seed-products.js
 * Adds all PC components to db.json as experimental products.
 * Run once: node seed-products.js
 * Then hit "Track Prices" in the admin panel to populate prices.
 */
const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');

function readDB() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch { return { products: [], priceHistory: {} }; }
}
function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const PRODUCTS_TO_ADD = [
    // ── AMD RX 9000 series (RDNA 4) ──────────────────────
    { name: 'AMD RX 9070 XT',            category: 'GPU' },
    { name: 'AMD RX 9070',               category: 'GPU' },
    { name: 'AMD RX 9060 XT',            category: 'GPU' },

    // ── AMD Ryzen 9000 series ─────────────────────────────
    { name: 'AMD Ryzen 9 9950X',         category: 'CPU' },
    { name: 'AMD Ryzen 9 9900X',         category: 'CPU' },
    { name: 'AMD Ryzen 7 9800X3D',       category: 'CPU' },
    { name: 'AMD Ryzen 7 9700X',         category: 'CPU' },
    { name: 'AMD Ryzen 5 9600X',         category: 'CPU' },

    // ── NVIDIA RTX 40 series ─────────────────────────────
    { name: 'NVIDIA RTX 4080 Super',     category: 'GPU' },
    { name: 'NVIDIA RTX 4080',           category: 'GPU' },
    { name: 'NVIDIA RTX 4070 Ti Super',  category: 'GPU' },
    { name: 'NVIDIA RTX 4070 Ti',        category: 'GPU' },
    { name: 'NVIDIA RTX 4070 Super',     category: 'GPU' },
    { name: 'NVIDIA RTX 4070',           category: 'GPU' },
    { name: 'NVIDIA RTX 4060 Ti 16GB',   category: 'GPU' },
    { name: 'NVIDIA RTX 4060 Ti',        category: 'GPU' },
    { name: 'NVIDIA RTX 4060',           category: 'GPU' },

    // ── AMD RX 7000 series ───────────────────────────────
    { name: 'AMD RX 7900 XTX',           category: 'GPU' },
    { name: 'AMD RX 7900 XT',            category: 'GPU' },
    { name: 'AMD RX 7800 XT',            category: 'GPU' },
    { name: 'AMD RX 7700 XT',            category: 'GPU' },
    { name: 'AMD RX 7600 XT',            category: 'GPU' },
    { name: 'AMD RX 7600',               category: 'GPU' },

    // ── Intel CPUs ───────────────────────────────────────
    { name: 'Intel Core i9-14900K',      category: 'CPU' },
    { name: 'Intel Core i7-14700K',      category: 'CPU' },
    { name: 'Intel Core i5-14600K',      category: 'CPU' },
    { name: 'Intel Core i5-14400F',      category: 'CPU' },

    // ── AMD CPUs ─────────────────────────────────────────
    { name: 'AMD Ryzen 9 7950X',         category: 'CPU' },
    { name: 'AMD Ryzen 9 7900X',         category: 'CPU' },
    { name: 'AMD Ryzen 7 7800X3D',       category: 'CPU' },
    { name: 'AMD Ryzen 7 7700X',         category: 'CPU' },
    { name: 'AMD Ryzen 5 7600X',         category: 'CPU' },
    { name: 'AMD Ryzen 5 7600',          category: 'CPU' },

    // ── RAM ──────────────────────────────────────────────
    { name: 'Corsair Vengeance DDR5 32GB 6000MHz', category: 'RAM' },
    { name: 'G.Skill Trident Z5 DDR5 32GB 6000MHz', category: 'RAM' },
    { name: 'Corsair Vengeance DDR4 32GB 3200MHz',  category: 'RAM' },
    { name: 'Kingston Fury Beast DDR4 16GB 3200MHz', category: 'RAM' },

    // ── SSDs ─────────────────────────────────────────────
    { name: 'Samsung 990 Pro 2TB NVMe SSD',  category: 'SSD' },
    { name: 'Samsung 990 Pro 1TB NVMe SSD',  category: 'SSD' },
    { name: 'WD Black SN850X 2TB NVMe SSD',  category: 'SSD' },
    { name: 'WD Black SN850X 1TB NVMe SSD',  category: 'SSD' },
    { name: 'Samsung 870 EVO 2TB SATA SSD',  category: 'SSD' },
    { name: 'Crucial MX500 1TB SATA SSD',    category: 'SSD' },

    // ── Monitors ─────────────────────────────────────────
    { name: 'LG 27GP850 27" 1440p 165Hz Gaming Monitor',       category: 'Monitor' },
    { name: 'Samsung Odyssey G5 27" 1440p 165Hz Monitor',      category: 'Monitor' },
    { name: 'AOC 24G2 24" 1080p 144Hz Gaming Monitor',         category: 'Monitor' },
    { name: 'BenQ MOBIUZ EX2710Q 27" 1440p 165Hz Monitor',     category: 'Monitor' },

    // ── PSUs ─────────────────────────────────────────────
    { name: 'Corsair RM1000x 1000W 80+ Gold PSU',  category: 'PSU' },
    { name: 'Corsair RM850x 850W 80+ Gold PSU',    category: 'PSU' },
    { name: 'Seasonic Focus GX-750 750W Gold PSU', category: 'PSU' },

    // ── Cases ────────────────────────────────────────────
    { name: 'Fractal Design North ATX Mid Tower Case', category: 'Case' },
    { name: 'NZXT H510 Flow ATX Mid Tower Case',       category: 'Case' },
    { name: 'Lian Li O11 Dynamic EVO ATX Case',        category: 'Case' },

    // ── CPU Coolers ──────────────────────────────────────
    { name: 'Noctua NH-D15 CPU Air Cooler',            category: 'Cooler' },
    { name: 'be quiet! Dark Rock Pro 4 CPU Cooler',    category: 'Cooler' },
    { name: 'Corsair H150i Elite 360mm AIO Cooler',    category: 'Cooler' },

    // ── Motherboards ─────────────────────────────────────
    { name: 'ASUS ROG Strix Z790-E Gaming WiFi Motherboard', category: 'Motherboard' },
    { name: 'MSI MAG B650 Tomahawk WiFi Motherboard',        category: 'Motherboard' },
    { name: 'Gigabyte Z790 AORUS Elite AX Motherboard',      category: 'Motherboard' },
];

function seed() {
    const db = readDB();
    if (!db.priceHistory) db.priceHistory = {};

    const existingNames = new Set(db.products.map(p => p.name.toLowerCase()));
    let added = 0;

    for (const item of PRODUCTS_TO_ADD) {
        if (existingNames.has(item.name.toLowerCase())) {
            console.log(`  skip (exists): ${item.name}`);
            continue;
        }
        const product = {
            id:           Date.now().toString() + Math.floor(Math.random() * 1000),
            name:         item.name,
            category:     item.category,
            price:        0,
            checkedAt:    null,
            experimental: true
        };
        db.products.push(product);
        db.priceHistory[product.id] = [];
        existingNames.add(item.name.toLowerCase());
        console.log(`  added: ${item.name}`);
        added++;
    }

    writeDB(db);
    console.log(`\n✅ Done. Added ${added} products. Run "Track Prices" in the admin panel to populate prices.\n`);
}

seed();
