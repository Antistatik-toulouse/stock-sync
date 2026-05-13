/**
 * fix-zakeke-skus.mjs
 * Corrige les SKUs Zakeke → SKU Toptex standard sur tous les produits concernés
 * Format correct: {REF}-{COLOR}-{SIZE}
 * Usage: SHOPIFY_TOKEN=xxx node fix-zakeke-skus.mjs [--dry-run]
 */
import { getAllProductIds, getAllVariants } from './shopify-utils.mjs';

const TOKEN = process.env.SHOPIFY_TOKEN;
const STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
const DRY_RUN = process.argv.includes('--dry-run');
if (!TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

// Produits avec des variants Zakeke à corriger
const PRODUCT_IDS = [
  'gid://shopify/Product/10195584713051', // T-shirt sport manches courtes Homme
  'gid://shopify/Product/10156372033883', // T-shirt Homme classique
  'gid://shopify/Product/10142295097691', // T-shirt Homme classique EXPRESS 24H
  'gid://shopify/Product/10106801488219', // T-shirt sport Enfant
  'gid://shopify/Product/10106786021723', // Body bébé
  'gid://shopify/Product/10027863245147', // Polo Femme K255
  'gid://shopify/Product/10027819991387', // T-shirt écoresponsable NS305
  'gid://shopify/Product/10025289875803', // T-shirt Femme classique CGTW02T
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sizeToSlug(sizeValue) {
  return sizeValue.trim().toUpperCase()
    .replace(/\//g, '-')
    .replace(/ ANS/g, 'ANS')
    .replace(/\s+/g, '-');
}

function colorToSlug(colorValue) {
  return colorValue.trim().toUpperCase().replace(/\s+/g, '-');
}

function isZakeke(sku) {
  if (!sku) return false;
  const lower = sku.toLowerCase();
  return lower.includes('zakeke') || (sku.includes(',') && sku.includes('-'));
}

function buildCorrectSku(currentSku, colorValue, sizeValue) {
  const ref = currentSku.split(',')[0].trim();
  return `${ref}-${colorToSlug(colorValue)}-${sizeToSlug(sizeValue)}`;
}

console.log(`\n🔧 Fix SKUs Zakeke → Toptex${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

let totalFixed = 0, totalErrors = 0, totalSkipped = 0;

for (const gid of PRODUCT_IDS) {
  const numericId = gid.split('/').pop();

  // Titre via GraphQL
  const titleRes = await fetch(`https://${STORE}/admin/api/2024-01/products/${numericId}.json?fields=id,title`, {
    headers: { 'X-Shopify-Access-Token': TOKEN }
  }).then(r => r.json());
  const title = titleRes.product?.title || gid;

  // Variantes via REST pagination (illimité)
  const variants = await getAllVariants(STORE, TOKEN, numericId);

  const zakeke = variants.filter(v => isZakeke(v.sku));

  if (zakeke.length === 0) {
    console.log(`✅ ${title}: aucun Zakeke (${variants.length} variants)`);
    continue;
  }

  console.log(`\n📦 ${title}: ${zakeke.length} Zakeke sur ${variants.length} variants`);

  let fixed = 0, errors = 0;

  for (const v of zakeke) {
    // Les options REST sont dans option1, option2, option3
    const colorValue = v.option1 || '';
    const sizeValue  = v.option2 || '';

    if (!colorValue || !sizeValue) {
      console.log(`  ⚠️  Options manquantes pour variant ${v.id}: opt1=${v.option1} opt2=${v.option2}`);
      totalSkipped++;
      continue;
    }

    const newSku = buildCorrectSku(v.sku, colorValue, sizeValue);

    if (DRY_RUN) {
      if (fixed < 5) console.log(`  ${v.sku} → ${newSku}`);
      fixed++;
      continue;
    }

    const r = await fetch(`https://${STORE}/admin/api/2024-01/variants/${v.id}.json`, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant: { id: v.id, sku: newSku } })
    });
    const json = await r.json();

    if (r.status !== 200 || json.errors) {
      errors++;
      totalErrors++;
      console.error(`  ❌ ${newSku}: ${JSON.stringify(json.errors || r.status)}`);
    } else {
      fixed++;
      totalFixed++;
    }
    process.stdout.write(`\r  ${fixed + errors}/${zakeke.length}`);
    await sleep(550);
  }

  if (!DRY_RUN) console.log(`\n  ✅ ${fixed} corrigés, ${errors} erreurs`);
  else console.log(`\n  (dry-run) ${fixed} à corriger`);
}

console.log(`\n══════════════════════════════`);
if (DRY_RUN) {
  console.log(`DRY RUN — relancer sans --dry-run pour appliquer`);
} else {
  console.log(`Total: ${totalFixed} corrigés, ${totalErrors} erreurs, ${totalSkipped} ignorés`);
}
