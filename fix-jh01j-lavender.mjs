/**
 * Diagnostique et corrige le doublon JH01J DIGITAL LAVENDER 12-13ANS / 12/13ANS
 */
import { getAllProductIds, getAllVariants } from './shopify-utils.mjs';
import { readFileSync } from 'fs';

const TOKEN = process.env.SHOPIFY_TOKEN;
const STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
const DRY_RUN = process.argv.includes('--dry-run');

const mapping = JSON.parse(readFileSync('./imbretex-code-to-sku.json'));
const mappedSkus = new Set(Object.values(mapping));

const products = await getAllProductIds(STORE, TOKEN, 'sku:JH01J*');
for (const p of products) {
  const variants = await getAllVariants(STORE, TOKEN, p.id);
  const lavender = variants.filter(v => v.sku && v.sku.includes('LAVENDER') && v.sku.includes('12'));
  if (lavender.length === 0) continue;

  console.log(`\n${p.title}:`);
  for (const v of lavender) {
    const inMapping = mappedSkus.has(v.sku);
    console.log(`  id=${v.id} sku="${v.sku}" opt2="${v.option2}" ${inMapping ? '✅ mappé' : '❌ NON MAPPÉ'}`);
  }

  // Trouver les non-mappés (doublon avec mauvais format)
  const wrong = lavender.filter(v => !mappedSkus.has(v.sku));
  const correct = lavender.filter(v => mappedSkus.has(v.sku));

  if (wrong.length > 0 && correct.length > 0) {
    console.log(`\n  → Doublon détecté. Variant correct: "${correct[0].sku}", doublon: "${wrong[0].sku}"`);
    // Renommer le doublon pour matcher le mapping
    const target = correct[0].sku; // SKU correct (avec slash)
    if (DRY_RUN) {
      console.log(`  (dry-run) renamerait ${wrong[0].sku} → ${target}`);
    } else {
      const r = await fetch(`https://${STORE}/admin/api/2024-01/variants/${wrong[0].id}.json`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: { id: wrong[0].id, sku: target } })
      });
      const j = await r.json();
      console.log(r.status === 200 ? `  ✅ Renommé → ${target}` : `  ❌ ${JSON.stringify(j.errors)}`);
    }
  } else if (wrong.length > 0 && correct.length === 0) {
    // Le mapping pointe vers un SKU inexistant — mettre à jour le mapping
    console.log(`\n  → SKU "${wrong[0].sku}" non mappé, et pas de variant correct trouvé.`);
    console.log(`  La clé Imbretex JH01JDL12 pointe vers un SKU fantôme.`);
    console.log(`  Fix: modifier le mapping pour pointer vers "${wrong[0].sku}"`);
    if (!DRY_RUN) {
      // Trouver la clé Imbretex correspondante
      const key = Object.entries(mapping).find(([k,v]) => v.includes('DIGITAL-LAVENDER') && v.includes('12'))?.[0];
      if (key) {
        mapping[key] = wrong[0].sku;
        const { writeFileSync } = await import('fs');
        writeFileSync('./imbretex-code-to-sku.json', JSON.stringify(mapping, null, 2));
        console.log(`  ✅ mapping[${key}] → ${wrong[0].sku}`);
      }
    }
  }
}
