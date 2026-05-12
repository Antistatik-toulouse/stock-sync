/**
 * sync-imbretex.mjs
 * Sync stocks Imbretex → Shopify
 * Usage: node sync-imbretex.mjs [--dry-run]
 */

import { writeFileSync } from 'fs';
import { createRequire } from 'module';
import { getAllProductIds, getAllVariants, ensureStockedAtLocation } from './shopify-utils.mjs';
const require = createRequire(import.meta.url);

const DRY_RUN = process.argv.includes('--dry-run');

// ── Credentials ──────────────────────────────────────────────
const SHOPIFY_TOKEN    = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE    = process.env.SHOPIFY_STORE    || 'antistatiksamedi.myshopify.com';
const IMBRE_CLIENT_ID  = process.env.IMBRE_CLIENT_ID;
const IMBRE_CLIENT_SECRET = process.env.IMBRE_CLIENT_SECRET;
const IMBRE_BASE_V2    = 'https://api.imbretex.fr/api/v2';

if (!SHOPIFY_TOKEN) throw new Error('SHOPIFY_TOKEN manquant');
if (!IMBRE_CLIENT_ID || !IMBRE_CLIENT_SECRET) throw new Error('IMBRE_CLIENT_ID / IMBRE_CLIENT_SECRET manquants');

// Obtenir le token OAuth2
async function getImbreToken() {
  const r = await fetch(`${IMBRE_BASE_V2}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: IMBRE_CLIENT_ID, client_secret: IMBRE_CLIENT_SECRET })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Token Imbretex invalide: ' + JSON.stringify(d));
  return d.access_token;
}

// ── Mapping Imbretex code → SKU Shopify (généré depuis line listing) ──
// Format: imbreCode → SKU Shopify attendu
const IMBRE_TO_SKU = await buildMapping();

// ── Helpers ────────────────────────────────────────────────────
async function shopifyGql(query, variables = {}) {
  const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}

async function fetchAllImbreStocks() {
  const stocks = {};
  const token = await getImbreToken();
  let page = 1, totalPages = 1;
  console.log('  Téléchargement stocks Imbretex (V2)...');
  do {
    let d;
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetch(`${IMBRE_BASE_V2}/stocks?page=${page}&perPage=100`, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
      });
      if (r.status === 429) {
        const wait = parseInt(r.headers.get('Retry-After') || '10') * 1000;
        await new Promise(res => setTimeout(res, wait || 15000));
        continue;
      }
      const text = await r.text();
      try { d = JSON.parse(text); } catch { await new Promise(res => setTimeout(res, 3000)); continue; }
      break;
    }
    if (!d?.data) throw new Error('Stocks invalides: ' + JSON.stringify(d).slice(0, 200));
    for (const s of d.data) stocks[s.code] = parseInt(s.stock, 10) || 0;
    totalPages = d.totalPages || 1;
    process.stdout.write(`\r  Page ${page}/${totalPages} — ${Object.keys(stocks).length} codes`);
    if (page >= totalPages) break;
    page++;
    await new Promise(res => setTimeout(res, 500)); // 500ms entre pages ≈ 2 req/s
  } while (true);
  console.log();
  return stocks;
}

async function fetchShopifyVariants() {
  const products = await getAllProductIds(SHOPIFY_STORE, SHOPIFY_TOKEN,
    'sku:JH* OR sku:BF* OR sku:B640* OR sku:BG42* OR sku:BY102* OR sku:CGTU03T* OR sku:CGTW02T* OR sku:B15*');
  const bysku = {};
  for (const p of products) {
    const variants = await getAllVariants(SHOPIFY_STORE, SHOPIFY_TOKEN, p.id);
    for (const v of variants) {
      if (v.sku) bysku[v.sku] = {
        sku: v.sku,
        inventoryItem: { id: `gid://shopify/InventoryItem/${v.inventory_item_id}` },
        inventoryQuantity: v.inventory_quantity
      };
    }
  }
  return bysku;
}

async function buildMapping() {
  // Mapping statique Imbretex code → SKU Shopify (basé sur line listing 27/04/2026)
  // Régénérer si le catalogue change via: node build-imbretex-mapping.mjs
  try {
    const { readFileSync } = await import('fs');
    return JSON.parse(readFileSync(new URL('./imbretex-code-to-sku.json', import.meta.url)));
  } catch {
    throw new Error('Fichier imbretex-code-to-sku.json manquant — lancer build-imbretex-mapping.mjs');
  }
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔄 Sync Imbretex → Shopify${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   ${new Date().toLocaleString('fr-FR')}\n`);

  // 1. Stocks Imbretex
  console.log('1. Stocks Imbretex...');
  const imbreStocks = await fetchAllImbreStocks();
  console.log(`   ✅ ${Object.keys(imbreStocks).length} codes chargés\n`);

  // 2. Variants Shopify
  console.log('2. Variants Shopify...');
  const shopifyBySku = await fetchShopifyVariants();
  console.log(`   ✅ ${Object.keys(shopifyBySku).length} variants\n`);

  // 3. Location Imbretex
  const locRes = await shopifyGql(`{ locations(first:10) { edges { node { id name } } } }`);
  const imbreLocation = locRes.data.locations.edges.find(e => e.node.name === 'Imbretex');
  if (!imbreLocation) throw new Error('Emplacement "Imbretex" introuvable dans Shopify');
  const locationId = imbreLocation.node.id;

  // 4. Calculer les mises à jour (dédupliquer par inventoryItemId — plusieurs codes Imbretex peuvent pointer le même SKU)
  console.log('3. Calcul des mises à jour...');
  const byInvItem = new Map(); // inventoryItemId → { sku, stock cumulé, oldStock }
  let skipped = 0;

  for (const [imbreCode, stock] of Object.entries(imbreStocks)) {
    const sku = IMBRE_TO_SKU[imbreCode];
    if (!sku) { skipped++; continue; }
    const variant = shopifyBySku[sku];
    if (!variant) { skipped++; continue; }
    const itemId = variant.inventoryItem.id;
    if (byInvItem.has(itemId)) {
      byInvItem.get(itemId).newStock += stock; // cumul si doublon
    } else {
      byInvItem.set(itemId, { inventoryItemId: itemId, sku, newStock: stock, oldStock: variant.inventoryQuantity });
    }
  }

  const updates = [...byInvItem.values()].filter(u => u.oldStock !== u.newStock);
  console.log(`   ✅ ${updates.length} variants à mettre à jour (${skipped} sans correspondance)\n`);

  if (updates.length === 0) {
    console.log('✅ Stocks déjà à jour.');
    return;
  }

  // Aperçu
  console.log('Aperçu (10 premiers):');
  updates.slice(0, 10).forEach(u => {
    const sign = u.newStock > u.oldStock ? '+' : '';
    console.log(`  ${u.sku.padEnd(40)} ${u.oldStock} → ${u.newStock} (${sign}${u.newStock - u.oldStock})`);
  });
  if (updates.length > 10) console.log(`  ... et ${updates.length - 10} autres\n`);

  if (DRY_RUN) {
    console.log('\n⏸  DRY RUN — rien envoyé à Shopify.');
    return;
  }

  // 4b. Connecter les items non encore rattachés à l'emplacement Imbretex
  const locationNumericId = locationId.split('/').pop();
  const allItemIds = updates.map(u => u.inventoryItemId.split('/').pop());
  const connected = await ensureStockedAtLocation(SHOPIFY_STORE, SHOPIFY_TOKEN, allItemIds, locationNumericId);
  if (connected > 0) console.log(`   ✅ ${connected} items connectés à Imbretex\n`);

  // 5. Mise à jour Shopify par batch de 250
  console.log(`4. Mise à jour Shopify...`);
  const BATCH = 250;
  let done = 0, errors = 0;

  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    const res = await shopifyGql(`
      mutation($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          inventoryAdjustmentGroup { reason }
          userErrors { field message }
        }
      }
    `, {
      input: {
        reason: 'correction',
        name: 'available',
        ignoreCompareQuantity: true,
        quantities: batch.map(u => ({
          inventoryItemId: u.inventoryItemId,
          locationId,
          quantity: u.newStock
        }))
      }
    });
    const errs = res.data?.inventorySetQuantities?.userErrors || [];
    if (errs.length) { errors += errs.length; errs.forEach(e => console.error('  ❌', e.message)); }
    done += batch.length;
    process.stdout.write(`\r  ${done}/${updates.length} mis à jour`);
  }
  console.log();

  // Rapport
  writeFileSync('./sync-imbretex.log',
    JSON.stringify({ date: new Date().toISOString(), updated: updates.length, errors,
      samples: updates.slice(0, 20) }, null, 2));

  console.log(`\n✅ Terminé — ${updates.length - errors} mis à jour, ${errors} erreurs`);
  console.log(`   Log: sync-imbretex.log`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
