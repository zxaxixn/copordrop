/**
 * update-products.js
 * - Adds new 2025-2026 products
 * - Assigns releaseOrder to all products (lower = newer)
 * - Sorts db.json by releaseOrder
 * Run: node update-products.js
 */
const fs   = require('fs');
const path = require('path');
const DB_FILE = path.join(__dirname, 'db.json');

function readDB()      { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { products: [], priceHistory: {} }; } }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// ── Release order map — lower = newer/higher priority ────────────
// Products are matched by substring of their name (lowercase)
const RELEASE_ORDER_MAP = [
    // ── NVIDIA RTX 50 series (2025-2026) ────────────────────────
    ['rtx 5090',           1],
    ['rtx 5080',           2],
    ['rtx 5070 ti',        3],
    ['rtx 5070',           4],
    ['rtx 5060 ti',        5],
    ['rtx 5060',           6],

    // ── AMD RX 9000 series RDNA4 (2025) ─────────────────────────
    ['rx 9070 xt',         10],
    ['rx 9070',            11],
    ['rx 9060 xt',         12],
    ['rx 9060',            13],

    // ── Intel Arc B series (Dec 2024) ────────────────────────────
    ['arc b580',           20],
    ['arc b570',           21],

    // ── Intel Arrow Lake Ultra (Oct 2024) ────────────────────────
    ['ultra 9 285k',       30],
    ['ultra 7 265k',       31],
    ['ultra 5 245k',       32],
    ['ultra 5 235k',       33],

    // ── AMD Ryzen 9000 series (2024-2025) ────────────────────────
    ['ryzen 9 9950x',      40],
    ['ryzen 9 9900x',      41],
    ['ryzen 7 9800x3d',    42],
    ['ryzen 7 9700x',      43],
    ['ryzen 5 9600x',      44],

    // ── New OLED / high-refresh monitors (2024-2025) ─────────────
    ['pg27ucdm',           50],
    ['27gs95qe',           51],
    ['aw3225qf',           52],
    ['mpg 321urx',         53],
    ['odyssey oled g8',    54],
    ['34gp950g',           55],
    ['rog swift pg32uqx',  56],

    // ── New cases (2024-2025) ─────────────────────────────────────
    ['hyte y70',           60],
    ['o11 air 2',          61],
    ['torrent rgb',        62],
    ['4000d airflow',      63],
    ['shadow base 800',    64],
    ['phanteks nv9',       65],
    ['nzxt h9',            66],

    // ── New coolers & fans (2024-2025) ────────────────────────────
    ['nh-d15 g2',          70],
    ['dark rock elite',    71],
    ['liquid freezer iii', 72],
    ['lt720',              73],
    ['phantom spirit 120', 74],
    ['nf-a12x25',          75],
    ['silent wings 4',     76],
    ['icue h170i',         77],

    // ── New Z890/X870E motherboards (2024) ───────────────────────
    ['z890',               80],
    ['x870e',              81],
    ['x870',               82],

    // ── High-wattage PSUs for RTX 5090 era ───────────────────────
    ['hx1500i',            90],
    ['dark power 13',      91],
    ['prime tx-1300',      92],
    ['rog thor 1000',      93],
    ['rm1200',             94],

    // ── PCIe 5.0 SSDs (2024-2025) ────────────────────────────────
    ['9100 pro',           100],
    ['t705',               101],
    ['sn850x 4tb',         102],
    ['990 pro 4tb',        103],

    // ── DDR5 high-speed RAM (2024-2025) ──────────────────────────
    ['dominator titanium', 110],
    ['trident z5 royal',   111],
    ['fury renegade ddr5', 112],

    // ── NVIDIA RTX 40 series (2023-2024) ─────────────────────────
    ['rtx 4090',           200],
    ['rtx 4080 super',     201],
    ['rtx 4080',           202],
    ['rtx 4070 ti super',  203],
    ['rtx 4070 ti',        204],
    ['rtx 4070 super',     205],
    ['rtx 4070',           206],
    ['rtx 4060 ti 16gb',   207],
    ['rtx 4060 ti',        208],
    ['rtx 4060',           209],

    // ── AMD RX 7000 series (2022-2024) ───────────────────────────
    ['rx 7900 xtx',        210],
    ['rx 7900 xt',         211],
    ['rx 7900 gre',        212],
    ['rx 7800 xt',         213],
    ['rx 7700 xt',         214],
    ['rx 7600 xt',         215],
    ['rx 7600',            216],

    // ── Intel 14th gen (2023-2024) ────────────────────────────────
    ['i9-14900k',          220],
    ['i7-14700k',          221],
    ['i5-14600k',          222],
    ['i5-14400f',          223],

    // ── AMD Ryzen 7000 series (2022-2024) ────────────────────────
    ['ryzen 9 7950x',      230],
    ['ryzen 9 7900x',      231],
    ['ryzen 7 7800x3d',    232],
    ['ryzen 7 7700x',      233],
    ['ryzen 5 7600x',      234],
    ['ryzen 5 7600',       235],

    // ── Monitors (non-OLED 2023-2024) ─────────────────────────────
    ['27gp850',            300],
    ['odyssey g5',         301],
    ['24g2',               302],
    ['ex2710q',            303],

    // ── Cases (2022-2023) ─────────────────────────────────────────
    ['fractal design north', 310],
    ['h510',               311],
    ['o11 dynamic evo',    312],

    // ── Coolers (older) ───────────────────────────────────────────
    ['nh-d15',             320],
    ['dark rock pro 4',    321],
    ['h150i elite',        322],

    // ── Motherboards (Z790/B650) ──────────────────────────────────
    ['z790-e',             330],
    ['b650 tomahawk',      331],
    ['z790 aorus elite',   332],

    // ── PSUs (standard) ───────────────────────────────────────────
    ['rm1000x',            340],
    ['rm850x',             341],
    ['focus gx-750',       342],

    // ── SSDs (standard) ───────────────────────────────────────────
    ['990 pro 2tb',        350],
    ['990 pro 1tb',        351],
    ['sn850x 2tb',         352],
    ['sn850x 1tb',         353],
    ['870 evo',            354],
    ['mx500',              355],

    // ── RAM (standard) ────────────────────────────────────────────
    ['vengeance ddr5 32gb 6000', 360],
    ['trident z5 ddr5 32gb 6000', 361],
    ['vengeance ddr4',     362],
    ['fury beast ddr4',    363],
];

function getReleaseOrder(name) {
    const lower = name.toLowerCase();
    for (const [keyword, order] of RELEASE_ORDER_MAP) {
        if (lower.includes(keyword)) return order;
    }
    return 999;
}

// ── New products to add ──────────────────────────────────────────
const NEW_PRODUCTS = [
    // Intel Arc GPUs (Dec 2024)
    { name: 'Intel Arc B580 12GB GPU',     category: 'GPU' },
    { name: 'Intel Arc B570 10GB GPU',     category: 'GPU' },

    // Intel Arrow Lake (Oct 2024)
    { name: 'Intel Core Ultra 9 285K',     category: 'CPU' },
    { name: 'Intel Core Ultra 7 265K',     category: 'CPU' },
    { name: 'Intel Core Ultra 5 245K',     category: 'CPU' },
    { name: 'Intel Core Ultra 5 235K',     category: 'CPU' },

    // OLED & high-refresh monitors (2024-2025)
    { name: 'ASUS ROG Swift OLED PG27UCDM 27" 4K 240Hz Monitor',      category: 'Monitor' },
    { name: 'LG 27GS95QE 27" 1440p 240Hz OLED Monitor',               category: 'Monitor' },
    { name: 'MSI MPG 321URX 32" 4K QD-OLED 144Hz Monitor',            category: 'Monitor' },
    { name: 'Samsung Odyssey OLED G8 34" Ultrawide 175Hz Monitor',     category: 'Monitor' },
    { name: 'Alienware AW3225QF 32" 4K OLED 240Hz Monitor',           category: 'Monitor' },
    { name: 'LG 34GP950G 34" Ultrawide 1440p 160Hz Monitor',          category: 'Monitor' },

    // New cases (2024-2025)
    { name: 'Hyte Y70 Touch ATX Mid Tower Case',                       category: 'Case' },
    { name: 'Lian Li O11 Air 2 ATX Mid Tower Case',                   category: 'Case' },
    { name: 'Fractal Design Torrent RGB ATX Case',                     category: 'Case' },
    { name: 'Corsair 4000D Airflow ATX Mid Tower Case',               category: 'Case' },
    { name: 'be quiet! Shadow Base 800 DX ATX Case',                  category: 'Case' },
    { name: 'Phanteks NV9 Full Tower Case',                            category: 'Case' },
    { name: 'NZXT H9 Flow ATX Mid Tower Case',                        category: 'Case' },

    // New coolers & fans (2024-2025)
    { name: 'Noctua NH-D15 G2 CPU Air Cooler',                        category: 'Cooler' },
    { name: 'be quiet! Dark Rock Elite CPU Cooler',                    category: 'Cooler' },
    { name: 'Arctic Liquid Freezer III 360mm AIO Cooler',             category: 'Cooler' },
    { name: 'DeepCool LT720 360mm AIO Cooler',                        category: 'Cooler' },
    { name: 'Thermalright Phantom Spirit 120 SE CPU Cooler',           category: 'Cooler' },
    { name: 'Noctua NF-A12x25 PWM 120mm Fan',                         category: 'Fan' },
    { name: 'be quiet! Silent Wings 4 140mm PWM Fan',                 category: 'Fan' },
    { name: 'Corsair iCUE H170i Elite 420mm AIO Cooler',              category: 'Cooler' },

    // New Z890 / X870E motherboards (2024)
    { name: 'ASUS ROG Maximus Z890 Apex Motherboard',                 category: 'Motherboard' },
    { name: 'MSI MEG Z890 ACE Motherboard',                           category: 'Motherboard' },
    { name: 'Gigabyte Z890 AORUS Master Motherboard',                 category: 'Motherboard' },
    { name: 'ASUS ROG Crosshair X870E Hero Motherboard',              category: 'Motherboard' },
    { name: 'MSI MEG X870E ACE Motherboard',                          category: 'Motherboard' },

    // High-wattage PSUs (RTX 5090 era)
    { name: 'Corsair HX1500i 1500W 80+ Platinum ATX 3.0 PSU',        category: 'PSU' },
    { name: 'be quiet! Dark Power 13 1000W 80+ Titanium PSU',        category: 'PSU' },
    { name: 'Seasonic Prime TX-1300W 80+ Titanium PSU',              category: 'PSU' },
    { name: 'ASUS ROG Thor 1000W Platinum II PSU',                    category: 'PSU' },

    // PCIe 5.0 SSDs (2024-2025)
    { name: 'Samsung 9100 Pro 2TB PCIe 5.0 NVMe SSD',                category: 'SSD' },
    { name: 'Samsung 9100 Pro 1TB PCIe 5.0 NVMe SSD',                category: 'SSD' },
    { name: 'Crucial T705 2TB PCIe 5.0 NVMe SSD',                    category: 'SSD' },
    { name: 'WD Black SN850X 4TB NVMe SSD',                          category: 'SSD' },

    // DDR5 high-speed RAM (2024-2025)
    { name: 'Corsair Dominator Titanium DDR5 32GB 7200MHz',           category: 'RAM' },
    { name: 'G.Skill Trident Z5 Royal DDR5 32GB 7200MHz',            category: 'RAM' },
    { name: 'Kingston Fury Renegade DDR5 32GB 6400MHz',              category: 'RAM' },
];

function run() {
    const db = readDB();
    if (!db.priceHistory) db.priceHistory = {};

    const existingNames = new Set(db.products.map(p => p.name.toLowerCase()));
    let added = 0;

    // Add new products
    for (const item of NEW_PRODUCTS) {
        if (existingNames.has(item.name.toLowerCase())) continue;
        const product = {
            id:           Date.now().toString() + Math.floor(Math.random() * 9999),
            name:         item.name,
            category:     item.category,
            price:        0,
            checkedAt:    null,
            experimental: true,
            releaseOrder: getReleaseOrder(item.name)
        };
        db.products.push(product);
        db.priceHistory[product.id] = [];
        existingNames.add(item.name.toLowerCase());
        console.log(`  added [${product.releaseOrder}]: ${item.name}`);
        added++;
    }

    // Assign / update releaseOrder on ALL products
    for (const p of db.products) {
        p.releaseOrder = getReleaseOrder(p.name);
    }

    // Sort products array by releaseOrder
    db.products.sort((a, b) => a.releaseOrder - b.releaseOrder);

    writeDB(db);
    console.log(`\n✅ Done. Added ${added} products. Total: ${db.products.length}. All sorted by release order.\n`);
}

run();
