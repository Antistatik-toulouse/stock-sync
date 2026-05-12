/**
 * build-imbretex-mapping.mjs
 * Reconstruit imbretex-code-to-sku.json en matchant contre les vrais SKUs Shopify
 * Usage: node build-imbretex-mapping.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { getAllProductIds, getAllVariants } from './shopify-utils.mjs';
const require = createRequire(import.meta.url);
const XLSX = require('./node_modules/xlsx');

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
if (!SHOPIFY_TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

// ── 1. Charger tous les SKUs Shopify JH*/BF* ──────────────────
async function fetchShopifySkus() {
  process.stdout.write('Chargement SKUs Shopify...');
  const products = await getAllProductIds(SHOPIFY_STORE, SHOPIFY_TOKEN,
    'sku:JH* OR sku:BF* OR sku:B640* OR sku:BG42* OR sku:BY102* OR sku:CGTU03T* OR sku:CGTW02T* OR sku:B15*');
  const skus = new Set();
  for (const p of products) {
    const variants = await getAllVariants(SHOPIFY_STORE, SHOPIFY_TOKEN, p.id);
    for (const v of variants) { if (v.sku) skus.add(v.sku); }
  }
  console.log(` ${products.length} produits → ${skus.size} SKUs trouvés`);
  return skus;
}

// ── 2. Lire le XLS ────────────────────────────────────────────
function readXls() {
  const wb = XLSX.readFile('/Users/antistatik/Shopify x Claude/LL 27042026 Client.xlsx');
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const ourRefs = ['JH001','JH01J','JH030','JH030J','JH043','JH043J','JH050','JH050J','BF789','BF090N',
                   'BF640','BF640B','BG042','BY102','BC03T','BF015','BC02T'];
  return data.slice(1).filter(row => ourRefs.includes(row[2]));
}

// ── 3. Générer les candidats slug couleur ─────────────────────
function colorCandidates(colorName) {
  const name = colorName.trim().toUpperCase();
  const words = name.split(/[\s\/]+/);
  const candidates = new Set();
  // Toutes les combinaisons de séparateurs pour les mots
  const seps = ['-', '+'];
  for (const sep of seps) {
    candidates.add(words.join(sep));
  }
  // Garder aussi le nom brut normalisé (cas comme TURQUOISE SURF → TURQUOISE)
  candidates.add(words[0]); // premier mot seul
  // Cas spéciaux connus — certains SKUs Shopify utilisent un format différent
  const aliases = {
    'TURQUOISE SURF':         ['TURQUOISE'],
    'CANDYFLOSS PINK':        ['CANDY+FLOSS+PINK', 'CANDY-FLOSS-PINK'],
    'CANDY FLOSS PINK':       ['CANDY+FLOSS+PINK', 'CANDY-FLOSS-PINK'],
    'PEPPERMINT':             ['PEPPER-MINT', 'PEPPERMINT'],
    'ORANGE CRUSH':           ['ORANGE-CRUSH', 'ORANGE+CRUSH'],
    'CHOCOLATE FUDGE BROWNIE':['CHOCOLATE+FUDGE+BROWN', 'CHOCOLATE-FUDGE-BROWNIE', 'CHOCOLATE+FUDGE+BROWNIE'],
    'JET BLACK':              ['DEEP+BLACK', 'DEEP-BLACK'],
    'HOT PINK':               ['LIPSTICK+PINK', 'LIPSTICK-PINK'],
    'OXFORD NAVY/HEATHER GREY':['OXFORD-NAVY-HEATHER', 'OXFORD+NAVY+HEATHER+GREY', 'OXFORD-NAVY-HEATHER-GREY'],
    'GRAPHITE HEATHER':       ['GRAPHITE+HEATHER', 'GRAPHITE-HEATHER'],
    'CARAMEL LATTE':          ['CARAMEL+LATTE', 'CARAMEL-LATTE'],
    'DEEP BLACK':             ['DEEP+BLACK', 'DEEP-BLACK'],
    'LAVENDER':               ['LAVENDER'],
    'ROYAL/WHITE':            ['ROYAL-BLUE-WHITE', 'ROYAL-WHITE', 'ROYAL+WHITE'],
  };
  const extra = aliases[name];
  if (extra) extra.forEach(a => candidates.add(a));
  return [...candidates];
}

// ── 4. Générer les candidats slug taille ──────────────────────
function sizeCandidates(sizeCode) {
  const s = String(sizeCode).trim();
  const candidates = new Set([s]);
  // Adulte : rien à transformer normalement
  // Enfant : "3/4 - XS" → "3/4ANS", "3-4ANS"
  const childMap = {
    '3/4 - XS':   ['3/4ANS','3-4ANS'],
    '5/6 - S':    ['5/6ANS','5-6ANS'],
    '7/8 - M':    ['7/8ANS','7-8ANS'],
    '9/11 - L':   ['9/11ANS','9-11ANS'],
    '12/13 - XL': ['12/13ANS','12-13ANS'],
  };
  if (childMap[s]) childMap[s].forEach(x => candidates.add(x));
  // Normaliser les slashes
  candidates.add(s.replace(/\//g, '-'));
  return [...candidates];
}

// ── Refs Imbretex qui correspondent à des produits Toptex dans Shopify ──
// Le SKU Shopify utilise le format Toptex (ex: B640-BLACK-XS)
const CROSS_REF = {
  'BF640':  'B640',
  'BF640B': 'B640B',
  'BG042':  'BG42',
  'BY102':  'BY102',
  'BC03T':  'CGTU03T',
  'BF015':  'B15',
  'BC02T':  'CGTW02T',
};

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const shopifySkus = await fetchShopifySkus();
  const rows = readXls();

  console.log(`\nTraitement ${rows.length} lignes XLS...`);

  const mapping = {};
  let matched = 0, unmatched = 0;
  const unmatchedExamples = [];

  for (const row of rows) {
    const imbreCode = String(row[3] || '').trim();
    const ref       = String(row[2] || '').trim();
    const colorName = String(row[12] || '').trim();
    const sizeCode  = String(row[15] || '').trim();

    if (!imbreCode || !ref || !colorName) continue;

    let found = null;

    // Pour les refs croisées, chercher avec le prefix Shopify Toptex
    const shopifyRef = CROSS_REF[ref] || ref;

    // Taille unique (BF789, size=0)
    if (sizeCode === '0' || sizeCode === '') {
      for (const colorSlug of colorCandidates(colorName)) {
        const candidate = `${shopifyRef}-${colorSlug}`;
        if (shopifySkus.has(candidate)) { found = candidate; break; }
      }
    } else {
      // Avec taille
      outer:
      for (const colorSlug of colorCandidates(colorName)) {
        for (const sizeSlug of sizeCandidates(sizeCode)) {
          const candidate = `${shopifyRef}-${colorSlug}-${sizeSlug}`;
          if (shopifySkus.has(candidate)) { found = candidate; break outer; }
        }
      }
    }

    if (found) {
      mapping[imbreCode] = found;
      matched++;
    } else {
      unmatched++;
      if (unmatchedExamples.length < 30) {
        unmatchedExamples.push({ ref, colorName, sizeCode, imbreCode });
      }
    }
  }

  console.log(`\n✅ Matchés   : ${matched}`);
  console.log(`❌ Non matchés: ${unmatched}`);

  if (unmatchedExamples.length > 0) {
    console.log('\nExemples non matchés:');
    unmatchedExamples.slice(0, 15).forEach(e =>
      console.log(`  ${e.ref} | ${e.colorName} | ${e.sizeCode} | ${e.imbreCode}`)
    );
  }

  writeFileSync('./imbretex-code-to-sku.json', JSON.stringify(mapping, null, 2));
  console.log(`\n💾 imbretex-code-to-sku.json mis à jour (${matched} entrées)`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
