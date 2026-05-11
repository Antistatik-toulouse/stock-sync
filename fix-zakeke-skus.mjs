/**
 * fix-zakeke-skus.mjs
 * Corrige les SKUs Zakeke → SKU Toptex standard sur tous les produits concernés
 * Format correct: {REF}-{COLOR}-{SIZE}
 * Usage: SHOPIFY_TOKEN=xxx node fix-zakeke-skus.mjs [--dry-run]
 */

const TOKEN = process.env.SHOPIFY_TOKEN;
const STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
const DRY_RUN = process.argv.includes('--dry-run');
if (!TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

const PRODUCT_IDS = [
  'gid://shopify/Product/10195584713051', // T-shirt sport manches courtes Homme
  'gid://shopify/Product/10156372033883', // T-shirt Homme classique
  'gid://shopify/Product/10142295097691', // T-shirt Homme classique EXPRESS 24H
  'gid://shopify/Product/10106801488219', // T-shirt sport Enfant
  'gid://shopify/Product/10106786021723', // Body bébé
  'gid://shopify/Product/10027863245147', // Polo Femme
  'gid://shopify/Product/10027819991387', // T-shirt écoresponsable
  'gid://shopify/Product/10025289875803', // T-shirt Femme classique
];

async function gql(query, variables = {}) {
  const r = await fetch(`https://${STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sizeToSlug(sizeValue) {
  return sizeValue.trim().toUpperCase()
    .replace(/\//g, '-')      // "6/8 ANS" → "6-8 ANS"
    .replace(/ ANS/g, 'ANS')  // "6-8 ANS" → "6-8ANS"
    .replace(/\s+/g, '-');    // "3 MOIS" → "3-MOIS"
}

function colorToSlug(colorValue) {
  return colorValue.trim().toUpperCase().replace(/\s+/g, '-');
}

function buildCorrectSku(currentSku, colorValue, sizeValue) {
  // Extraire la ref avant la virgule
  const ref = currentSku.split(',')[0].trim();
  const color = colorToSlug(colorValue);
  const size = sizeToSlug(sizeValue);
  return `${ref}-${color}-${size}`;
}

console.log(`\n🔧 Fix SKUs Zakeke → Toptex${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

let totalFixed = 0, totalErrors = 0, totalSkipped = 0;

for (const pid of PRODUCT_IDS) {
  const res = await gql(`
    query($id: ID!) {
      product(id: $id) {
        title
        variants(first: 250) {
          edges {
            node {
              id sku
              selectedOptions { name value }
            }
          }
        }
      }
    }
  `, { id: pid });

  const product = res.data?.product;
  if (!product) { console.log(`⚠️  Produit ${pid} introuvable`); continue; }

  const variants = product.variants.edges.map(e => e.node);
  const zakeke = variants.filter(v => v.sku?.includes('ZAKEKE') || v.sku?.includes(',-'));

  if (zakeke.length === 0) {
    console.log(`✅ ${product.title}: aucun Zakeke`);
    continue;
  }

  console.log(`\n📦 ${product.title}: ${zakeke.length} à corriger`);

  let fixed = 0, errors = 0;

  for (const v of zakeke) {
    const colorOpt = v.selectedOptions?.find(o => /colou?r|couleur|teinte/i.test(o.name))
                  || v.selectedOptions?.[0];
    const sizeOpt  = v.selectedOptions?.find(o => /size|taille|pointure/i.test(o.name))
                  || v.selectedOptions?.[1];

    if (!colorOpt || !sizeOpt) {
      console.log(`  ⚠️  Options manquantes pour ${v.id}: ${v.selectedOptions?.map(o=>o.name+'='+o.value).join(', ')}`);
      totalSkipped++;
      continue;
    }

    const newSku = buildCorrectSku(v.sku, colorOpt.value, sizeOpt.value);

    if (DRY_RUN) {
      if (fixed < 5) console.log(`  ${v.sku} → ${newSku}`);
      fixed++;
      continue;
    }

    const numericId = v.id.split('/').pop();
    const r = await fetch(`https://${STORE}/admin/api/2024-01/variants/${numericId}.json`, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant: { id: numericId, sku: newSku } })
    });
    const json = await r.json();

    if (r.status !== 200 || json.errors) {
      errors++;
      totalErrors++;
      console.error(`  ❌ ${v.sku} → ${newSku}: ${JSON.stringify(json.errors || r.status)}`);
    } else {
      fixed++;
      totalFixed++;
    }
    process.stdout.write(`\r  ${fixed + errors}/${zakeke.length}`);
    await sleep(550);
  }

  console.log(`\n  ✅ ${fixed} corrigés, ${errors} erreurs`);
}

console.log(`\n══════════════════════════════`);
if (DRY_RUN) {
  console.log(`DRY RUN — relancer sans --dry-run pour appliquer`);
} else {
  console.log(`Total: ${totalFixed} corrigés, ${totalErrors} erreurs, ${totalSkipped} ignorés`);
}
