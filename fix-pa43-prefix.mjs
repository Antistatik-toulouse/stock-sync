/**
 * fix-pa43-prefix.mjs
 * Corrige les SKUs avec préfixe PA43 → PA438 ou PA439
 * Usage: SHOPIFY_TOKEN=xxx node fix-pa43-prefix.mjs [--dry-run]
 */
import { getAllProductIds, getAllVariants } from './shopify-utils.mjs';

const TOKEN = process.env.SHOPIFY_TOKEN;
const STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
const DRY_RUN = process.argv.includes('--dry-run');
if (!TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log(`\n🔧 Fix préfixe PA43 → PA438/PA439${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

// Chercher les produits avec SKU PA43*
const products = await getAllProductIds(STORE, TOKEN, 'sku:PA43*');
console.log(`${products.length} produit(s) avec SKU PA43*`);

let totalFixed = 0, totalErrors = 0;

for (const p of products) {
  const variants = await getAllVariants(STORE, TOKEN, p.id);
  const toFix = variants.filter(v => v.sku && /^PA43[^389]/.test(v.sku));

  if (toFix.length === 0) { console.log(`✅ ${p.title}: aucun PA43 ambigu`); continue; }

  console.log(`\n📦 ${p.title}: ${toFix.length} variants`);
  toFix.slice(0, 5).forEach(v => console.log(`  ${v.sku}`));

  // Demander à l'utilisateur quel préfixe correct (PA438 ou PA439)
  // Pour l'instant on arrête ici et on affiche les SKUs pour décision
  console.log(`  → vérifier manuellement si PA438 ou PA439`);
}

console.log('\nSi PA43 doit → PA438 ou PA439, relancer avec --fix-to=PA438 ou --fix-to=PA439');
