/**
 * fix-jh043-royal-sku.mjs
 * Corrige les SKUs JH043 : ROYAL-BLUE-WHITE → ROYAL-WHITE
 * Usage: SHOPIFY_TOKEN=xxx node fix-jh043-royal-sku.mjs [--dry-run]
 */

const DRY_RUN = process.argv.includes('--dry-run');
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
  console.log(`\nFix SKUs JH043 ROYAL-BLUE-WHITE → ROYAL-WHITE${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  // Charger tous les produits JH043
  const res = await gql(`{
    products(first: 10, query: "sku:JH043*") {
      edges { node {
        id title
        variants(first: 250) {
          edges { node {
            id sku
            selectedOptions { name value }
          }}
        }
      }}
    }
  }`);

  const toFix = [];

  for (const { node: p } of res.data?.products?.edges || []) {
    for (const { node: v } of p.variants.edges) {
      if (!v.sku?.includes('ROYAL-BLUE-WHITE')) continue;
      const newSku = v.sku.replace('ROYAL-BLUE-WHITE', 'ROYAL-WHITE');
      toFix.push({ productTitle: p.title, variantId: v.id, oldSku: v.sku, newSku });
    }
  }

  if (toFix.length === 0) {
    console.log('Aucun SKU ROYAL-BLUE-WHITE trouvé.');
    return;
  }

  console.log(`${toFix.length} variants à corriger :\n`);
  toFix.forEach(v => console.log(`  ${v.oldSku} → ${v.newSku}`));
  console.log();

  if (DRY_RUN) { console.log('⏸  DRY RUN — rien modifié.'); return; }

  let done = 0, errors = 0;
  for (const v of toFix) {
    const r = await gql(`mutation($id: ID!, $input: ProductVariantInput!) {
      productVariantUpdate(id: $id, input: $input) {
        productVariant { id sku }
        userErrors { field message }
      }
    }`, { id: v.variantId, input: { id: v.variantId, sku: v.newSku } });

    const errs = r.data?.productVariantUpdate?.userErrors || [];
    if (errs.length) {
      errors++;
      errs.forEach(e => console.error(`  ❌ ${v.oldSku}: ${e.message}`));
    } else {
      done++;
      console.log(`  ✅ ${v.newSku}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n✅ ${done} SKUs corrigés, ${errors} erreurs`);
  console.log('\nRelance maintenant : node build-imbretex-mapping.mjs');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
