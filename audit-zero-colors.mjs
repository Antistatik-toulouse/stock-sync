/**
 * audit-zero-colors.mjs
 * Détecte les coloris dont TOUTES les tailles sont à 0 stock
 * Usage: SHOPIFY_TOKEN=xxx node audit-zero-colors.mjs
 */

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
if (!SHOPIFY_TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

import { getAllVariants } from './shopify-utils.mjs';

const API = `https://${SHOPIFY_STORE}/admin/api/2024-01`;

async function restGet(path) {
  const r = await fetch(`${API}${path}`, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
  if (r.status === 429) {
    await new Promise(res => setTimeout(res, parseInt(r.headers.get('Retry-After') || '2') * 1000));
    return restGet(path);
  }
  return { data: await r.json(), link: r.headers.get('link') };
}

async function getAllProducts() {
  const products = [];
  let path = '/products.json?limit=250&fields=id,title,options';
  while (path) {
    const { data, link } = await restGet(path);
    products.push(...data.products);
    const next = link?.match(/<([^>]+)>; rel="next"/);
    path = next ? next[1].replace(`${API}`, '') : null;
  }
  return products;
}

async function main() {
  console.log('\nAudit coloris entièrement à 0 (JH*/BF*)\n');

  const allProducts = await getAllProducts();

  // Charger tous les variants via REST paginé, filtrer JH*/BF*
  const products = [];
  for (const p of allProducts) {
    const variants = await getAllVariants(SHOPIFY_STORE, SHOPIFY_TOKEN, p.id);
    const relevant = variants.filter(v => v.sku && /^(JH|BF)/.test(v.sku));
    if (relevant.length > 0) products.push({ title: p.title, variants: relevant });
  }

  console.log(`${products.length} produits chargés\n`);

  const zeroColors = [];

  for (const p of products) {
    const byColor = {};
    for (const v of p.variants) {
      const color = v.option1 || 'Sans couleur';
      if (!byColor[color]) byColor[color] = [];
      byColor[color].push({ sku: v.sku, stock: v.inventory_quantity });
    }

    for (const [color, variants] of Object.entries(byColor)) {
      const totalStock = variants.reduce((s, v) => s + (v.stock || 0), 0);
      if (totalStock === 0) {
        zeroColors.push({ product: p.title, color, count: variants.length, skuExample: variants[0]?.sku });
      }
    }
  }

  if (zeroColors.length === 0) {
    console.log('✅ Aucun coloris entièrement à 0.');
    return;
  }

  console.log(`${zeroColors.length} coloris entièrement à 0 :\n`);
  zeroColors.forEach(z => {
    console.log(`  ${z.product} — ${z.color} (${z.count} tailles) — ex: ${z.skuExample}`);
  });
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
