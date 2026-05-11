/**
 * fix-jh001-missing-skus.mjs
 * Renseigne les SKUs manquants sur les variants JH001 dans Shopify
 * Usage: SHOPIFY_TOKEN=xxx node fix-jh001-missing-skus.mjs [--dry-run]
 */

const TOKEN = process.env.SHOPIFY_TOKEN;
const STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
const DRY_RUN = process.argv.includes('--dry-run');
if (!TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

// Mapping couleur Shopify → slug SKU (format Fruit of the Loom)
// Les couleurs Shopify sont en Title Case, les SKUs en UPPER+SLUG
function colorToSlug(colorValue) {
  const upper = colorValue.trim().toUpperCase();
  const overrides = {
    'CANDYFLOSS PINK':          'CANDY+FLOSS+PINK',
    'CANDY FLOSS PINK':         'CANDY+FLOSS+PINK',
    'TURQUOISE SURF':           'TURQUOISE',
    'PEPPERMINT':               'PEPPERMINT',
    'CHOCOLATE FUDGE BROWNIE':  'CHOCOLATE+FUDGE+BROWNIE',
    'OXFORD NAVY/HEATHER GREY': 'OXFORD-NAVY-HEATHER-GREY',
    'GRAPHITE HEATHER':         'GRAPHITE+HEATHER',
    'CARAMEL LATTE':            'CARAMEL+LATTE',
    'DEEP BLACK':               'DEEP+BLACK',
    'DIGITAL LAVENDER':         'DIGITAL+LAVENDER',
    'ORANGE CRUSH':             'ORANGE+CRUSH',
    'PLATINIUM GREY':           'PLATINIUM-GREY',
  };
  if (overrides[upper]) return overrides[upper];
  // Règle générale : mots séparés par +
  return upper.split(/[\s\/]+/).join('+');
}

// Tailles adultes standard (JH001)
const VALID_SIZES = new Set(['XS','S','M','L','XL','2XL','3XL','4XL','5XL']);

async function gql(query, variables = {}) {
  const r = await fetch(`https://${STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new Error('Réponse non-JSON: ' + text.slice(0, 300)); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Récupérer tous les produits JH001 ──────────────────────────
async function fetchJH001Products() {
  const products = [];
  let cursor = null;
  do {
    const res = await gql(`
      query($cursor: String) {
        products(first: 5, query: "sku:JH001*", after: $cursor) {
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
    `, { cursor });
    for (const { node } of res.data?.products?.edges || []) products.push(node);
    cursor = res.data?.products?.pageInfo?.hasNextPage
      ? res.data.products.pageInfo.endCursor : null;
    await sleep(600);
  } while (cursor);

  // Aussi chercher par titre pour attraper les produits sans aucun SKU JH001* encore
  const res2 = await gql(`{
    products(first: 10, query: "title:*JH001* OR title:*Fruit*Loom*") {
      edges { node { id title variants(first: 250) { edges { node { id sku inventoryQuantity selectedOptions { name value } } } } } }
    }
  }`);
  for (const { node } of res2.data?.products?.edges || []) {
    if (!products.find(p => p.id === node.id)) products.push(node);
  }

  return products;
}

// ── Main ───────────────────────────────────────────────────────
console.log(`\n🔧 Fix SKUs JH001${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

const products = await fetchJH001Products();
console.log(`${products.length} produit(s) JH001 trouvé(s):`);
products.forEach(p => console.log(`  • ${p.title} (${p.id})`));

let toFix = [];

for (const product of products) {
  const variants = product.variants.edges.map(e => e.node);
  const missing = variants.filter(v => !v.sku || v.sku.trim() === '');
  const withSku = variants.filter(v => v.sku && v.sku.trim() !== '');

  console.log(`\n📦 ${product.title}`);
  console.log(`   Total variants: ${variants.length} | Avec SKU: ${withSku.length} | Sans SKU: ${missing.length}`);

  // Déduire le préfixe ref depuis les SKUs existants
  let refPrefix = 'JH001';
  if (withSku.length > 0) {
    const sample = withSku[0].sku;
    refPrefix = sample.split('-')[0]; // ex: JH001
    console.log(`   Préfixe détecté: ${refPrefix} (depuis ${sample})`);
  }

  for (const v of missing) {
    const colorOpt = v.selectedOptions?.find(o =>
      ['color','colour','couleur','taille'].every(x => !o.name.toLowerCase().includes('taille')) &&
      ['color','colour','couleur','teinte','coloris'].some(x => o.name.toLowerCase().includes(x))
    ) || v.selectedOptions?.[0];

    const sizeOpt = v.selectedOptions?.find(o =>
      ['size','taille','pointure'].some(x => o.name.toLowerCase().includes(x))
    ) || v.selectedOptions?.[1];

    if (!colorOpt || !sizeOpt) {
      console.log(`   ⚠️  Options non trouvées pour variant ${v.id}: ${v.selectedOptions?.map(o=>o.name+'='+o.value).join(', ')}`);
      continue;
    }

    const colorSlug = colorToSlug(colorOpt.value);
    const sizeVal   = sizeOpt.value.toUpperCase().replace(/\s+/g,'');

    const sku = `${refPrefix}-${colorSlug}-${sizeVal}`;
    toFix.push({ id: v.id, sku, color: colorOpt.value, size: sizeOpt.value });
  }
}

if (toFix.length === 0) {
  console.log('\n✅ Aucun variant sans SKU trouvé.');
  process.exit(0);
}

console.log(`\n${toFix.length} SKUs à renseigner:`);
toFix.slice(0, 20).forEach(f => console.log(`  ${f.color} / ${f.size} → ${f.sku}`));
if (toFix.length > 20) console.log(`  ... et ${toFix.length - 20} autres`);

if (DRY_RUN) {
  console.log('\n⏸  DRY RUN — rien modifié.');
  process.exit(0);
}

// ── Mise à jour ─────────────────────────────────────────────────
console.log('\nMise à jour des SKUs...');
let done = 0, errors = 0;

for (const { id, sku } of toFix) {
  // Extraire l'ID numérique depuis le GID Shopify
  const numericId = id.split('/').pop();
  const res = await fetch(`https://${STORE}/admin/api/2024-01/variants/${numericId}.json`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ variant: { id: numericId, sku } })
  });
  const json = await res.json();
  if (res.status !== 200 || json.errors) {
    errors++;
    console.error(`  ❌ ${sku}: ${JSON.stringify(json.errors || res.status)}`);
  } else {
    done++;
  }
  process.stdout.write(`\r  ${done + errors}/${toFix.length} traités`);
  await sleep(600);
}

console.log(`\n\n✅ ${done} SKUs mis à jour, ${errors} erreurs`);
if (done > 0) {
  console.log('\n💡 Lance maintenant: node build-imbretex-mapping.mjs');
  console.log('   puis: node sync-imbretex.mjs');
}
