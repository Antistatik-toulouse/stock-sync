/**
 * build-imbretex-mapping.mjs
 * Reconstruit imbretex-code-to-sku.json en matchant contre les vrais SKUs Shopify
 * Usage: node build-imbretex-mapping.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('./node_modules/xlsx');

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
if (!SHOPIFY_TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

// ── 1. Charger tous les SKUs Shopify JH*/BF* ──────────────────
async function fetchShopifySkus() {
  const skus = new Set();
  let cursor = null;
  process.stdout.write('Chargement SKUs Shopify...');
  do {
    const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($cursor: String) {
          products(first: 50, query: "sku:JH* OR sku:BF*", after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges { node { variants(first: 250) { edges { node { sku } } } } }
          }
        }`,
        variables: { cursor }
      })
    }).then(r => r.json());
    for (const { node: p } of res.data?.products?.edges || []) {
      for (const { node: v } of p.variants.edges) {
        if (v.sku) skus.add(v.sku);
      }
    }
    cursor = res.data?.products?.pageInfo?.hasNextPage
      ? res.data?.products?.pageInfo?.endCursor : null;
  } while (cursor);
  console.log(` ${skus.size} SKUs trouvés`);
  return skus;
}

// ── 2. Lire le XLS ────────────────────────────────────────────
function readXls() {
  const wb = XLSX.readFile('/Users/antistatik/Shopify x Claude/LL 27042026 Client.xlsx');
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const ourRefs = ['JH001','JH01J','JH030','JH030J','JH043','JH043J','JH050','JH050J','BF789','BF090N'];
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
    'OXFORD NAVY/HEATHER GREY':['OXFORD-NAVY-HEATHER', 'OXFORD+NAVY+HEATHER+GREY', 'OXFORD-NAVY-HEATHER-GREY'],
    'GRAPHITE HEATHER':       ['GRAPHITE+HEATHER', 'GRAPHITE-HEATHER'],
    'CARAMEL LATTE':          ['CARAMEL+LATTE', 'CARAMEL-LATTE'],
    'DEEP BLACK':             ['DEEP+BLACK', 'DEEP-BLACK'],
    'LAVENDER':               ['LAVENDER'],
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

    // Taille unique (BF789, size=0)
    if (sizeCode === '0' || sizeCode === '') {
      for (const colorSlug of colorCandidates(colorName)) {
        const candidate = `${ref}-${colorSlug}`;
        if (shopifySkus.has(candidate)) { found = candidate; break; }
      }
    } else {
      // Avec taille
      outer:
      for (const colorSlug of colorCandidates(colorName)) {
        for (const sizeSlug of sizeCandidates(sizeCode)) {
          const candidate = `${ref}-${colorSlug}-${sizeSlug}`;
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
