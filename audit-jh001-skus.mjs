/**
 * audit-jh001-skus.mjs
 * Vérifie que tous les SKUs JH001 Shopify sont remplis et correspondent au XLS Imbretex
 * Usage: SHOPIFY_TOKEN=xxx node audit-jh001-skus.mjs
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const XLSX = require('./node_modules/xlsx');

const TOKEN = process.env.SHOPIFY_TOKEN;
const STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
if (!TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

async function gql(query, variables = {}) {
  const r = await fetch(`https://${STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error('Non-JSON: ' + text.slice(0, 200)); }
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 1. SKUs Shopify JH001 ─────────────────────────────────────
console.log('1. Chargement variants JH001 depuis Shopify...');
const shopifyVariants = []; // { sku, color, size, qty, id }
let cursor = null;
do {
  const res = await gql(`
    query($c: String) {
      products(first: 10, query: "sku:JH001*", after: $c) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id title
            variants(first: 250) {
              edges {
                node {
                  id sku inventoryQuantity
                  selectedOptions { name value }
                }
              }
            }
          }
        }
      }
    }
  `, { c: cursor });
  for (const { node: p } of res.data?.products?.edges || []) {
    for (const { node: v } of p.variants.edges) {
      const color = v.selectedOptions?.find(o => /colou?r|couleur|teinte/i.test(o.name))?.value
                 || v.selectedOptions?.[0]?.value || '';
      const size  = v.selectedOptions?.find(o => /size|taille/i.test(o.name))?.value
                 || v.selectedOptions?.[1]?.value || '';
      shopifyVariants.push({ id: v.id, sku: v.sku || '', color, size, qty: v.inventoryQuantity });
    }
  }
  cursor = res.data?.products?.pageInfo?.hasNextPage ? res.data.products.pageInfo.endCursor : null;
  await sleep(600);
} while (cursor);

console.log(`   ${shopifyVariants.length} variants trouvés`);

const noSku    = shopifyVariants.filter(v => !v.sku || v.sku.trim() === '');
const withSku  = shopifyVariants.filter(v => v.sku && v.sku.trim() !== '');
console.log(`   Avec SKU    : ${withSku.length}`);
console.log(`   Sans SKU    : ${noSku.length}`);

if (noSku.length > 0) {
  console.log('\n   ⚠️  Variants SANS SKU:');
  const byColor = {};
  for (const v of noSku) {
    if (!byColor[v.color]) byColor[v.color] = [];
    byColor[v.color].push(v.size);
  }
  for (const [color, sizes] of Object.entries(byColor).sort()) {
    console.log(`     ${color}: ${sizes.join(', ')}`);
  }
}

// ── 2. Couleurs JH001 dans le XLS ─────────────────────────────
console.log('\n2. Chargement XLS Imbretex...');
const wb = XLSX.readFile('/Users/antistatik/Shopify x Claude/LL 27042026 Client.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(1)
  .filter(r => String(r[2] || '').trim() === 'JH001');
console.log(`   ${rows.length} lignes JH001 dans le XLS`);

// Extraire toutes les combinaisons couleur+taille du XLS
const xlsCombos = new Map(); // "COLOR|SIZE" → imbreCode
for (const row of rows) {
  const color    = String(row[12] || '').trim().toUpperCase();
  const size     = String(row[15] || '').trim().toUpperCase();
  const imbreCode = String(row[3] || '').trim();
  if (color && imbreCode) xlsCombos.set(`${color}|${size}`, imbreCode);
}
const xlsColors = new Set([...xlsCombos.keys()].map(k => k.split('|')[0]));
console.log(`   ${xlsColors.size} couleurs distinctes dans le XLS pour JH001`);

// ── 3. Mapping actuel ──────────────────────────────────────────
const mapping = JSON.parse(readFileSync('./imbretex-code-to-sku.json'));
const mappedSkus = new Set(Object.values(mapping));
const jh001MappedSkus = new Set([...mappedSkus].filter(s => s.startsWith('JH001')));
console.log(`\n3. Mapping actuel: ${jh001MappedSkus.size} SKUs JH001 dans imbretex-code-to-sku.json`);

// ── 4. Croisement ─────────────────────────────────────────────
console.log('\n4. Analyse croisée:\n');

// Couleurs dans Shopify (avec SKU) qui ne sont PAS dans le mapping
const shopifyColors = new Set(withSku.map(v => {
  const parts = v.sku.split('-');
  return parts.slice(1, -1).join('-'); // slug couleur
}));

const skuInShopifyNotMapped = withSku.filter(v => !mappedSkus.has(v.sku));
if (skuInShopifyNotMapped.length > 0) {
  const byColor = {};
  for (const v of skuInShopifyNotMapped) {
    const colorSlug = v.sku.split('-').slice(1,-1).join('-');
    if (!byColor[colorSlug]) byColor[colorSlug] = 0;
    byColor[colorSlug]++;
  }
  console.log(`   ❌ SKUs dans Shopify mais PAS dans le mapping (${skuInShopifyNotMapped.length} variants):`);
  for (const [color, count] of Object.entries(byColor).sort()) {
    const sample = skuInShopifyNotMapped.find(v => v.sku.includes(color));
    console.log(`     ${color} (${count} tailles) — ex: ${sample?.sku}`);
  }
} else {
  console.log('   ✅ Tous les SKUs Shopify sont dans le mapping');
}

// Couleurs XLS non trouvées dans Shopify
console.log('\n   Couleurs XLS absentes de Shopify (variants sans SKU ou SKU manquant):');
let xlsMissingInShopify = 0;
const shopifyColorOptions = new Set(withSku.map(v => v.color.toUpperCase()));

for (const xlsColor of [...xlsColors].sort()) {
  const inShopify = [...shopifyColorOptions].some(c =>
    c === xlsColor || c.replace(/[\s\/]+/g,'+') === xlsColor.replace(/[\s\/]+/g,'+')
  );
  if (!inShopify) {
    xlsMissingInShopify++;
    console.log(`     ❌ ${xlsColor}`);
  }
}
if (xlsMissingInShopify === 0) console.log('     ✅ Toutes les couleurs XLS présentes dans Shopify');

// ── 5. Résumé ─────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('RÉSUMÉ');
console.log('══════════════════════════════════════════');
console.log(`Variants Shopify JH001     : ${shopifyVariants.length}`);
console.log(`  └ avec SKU               : ${withSku.length}`);
console.log(`  └ sans SKU               : ${noSku.length}`);
console.log(`Couleurs XLS Imbretex      : ${xlsColors.size}`);
console.log(`SKUs JH001 dans mapping    : ${jh001MappedSkus.size}`);
console.log(`SKUs Shopify non mappés    : ${skuInShopifyNotMapped.length}`);
console.log(`Couleurs XLS hors Shopify  : ${xlsMissingInShopify}`);

if (noSku.length > 0 || skuInShopifyNotMapped.length > 0) {
  console.log('\n⚠️  Actions recommandées:');
  if (noSku.length > 0)
    console.log(`  1. Renseigner ${noSku.length} SKUs manquants → node fix-jh001-missing-skus.mjs --dry-run`);
  if (skuInShopifyNotMapped.length > 0)
    console.log(`  2. Reconstruire le mapping → node build-imbretex-mapping.mjs`);
} else {
  console.log('\n✅ Tout est en ordre — relancer build-imbretex-mapping.mjs pour s\'en assurer');
}
