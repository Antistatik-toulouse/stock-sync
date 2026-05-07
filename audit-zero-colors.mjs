/**
 * audit-zero-colors.mjs
 * Détecte les coloris dont TOUTES les tailles sont à 0 stock
 * Usage: SHOPIFY_TOKEN=xxx node audit-zero-colors.mjs
 */

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
if (!SHOPIFY_TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

async function gql(query, variables = {}) {
  const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}

async function main() {
  console.log('\nAudit coloris entièrement à 0 (JH*/BF*)\n');

  const products = [];
  let cursor = null;
  do {
    const res = await gql(`query($cursor: String) {
      products(first: 50, query: "sku:JH* OR sku:BF*", after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          title
          variants(first: 250) { edges { node {
            sku inventoryQuantity
            selectedOptions { name value }
          }}}
        }}
      }
    }`, { cursor });
    for (const { node: p } of res.data?.products?.edges || []) products.push(p);
    cursor = res.data?.products?.pageInfo?.hasNextPage
      ? res.data?.products?.pageInfo?.endCursor : null;
  } while (cursor);

  console.log(`${products.length} produits chargés\n`);

  const zeroColors = [];

  for (const p of products) {
    // Grouper par couleur
    const byColor = {};
    for (const { node: v } of p.variants.edges) {
      const color = v.selectedOptions.find(o => o.name === 'Couleur')?.value || 'Sans couleur';
      if (!byColor[color]) byColor[color] = [];
      byColor[color].push({ sku: v.sku, stock: v.inventoryQuantity });
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
