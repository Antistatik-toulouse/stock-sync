/**
 * audit-full.mjs — Audit complet : SKUs, fournisseurs, pagination illimitée
 * Usage: SHOPIFY_TOKEN=xxx node audit-full.mjs
 */
import { readFileSync } from 'fs';
import { getAllProductIds, getAllVariants } from './shopify-utils.mjs';

const TOKEN = process.env.SHOPIFY_TOKEN;
const STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
if (!TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

const TOPTEX_REFS = new Set([
  'BG42','KP064','K832','B445','B640','B640B','B15','BG125J','YHVW100',
  'NS208','NS207','K254','K268','PA970','PA169','NS404','NS401','NS403',
  'NS400','NS405','NS402','K381','K357','PA439','PA438','NS307','NS324',
  'NS332','CGTK002','CGTW02T','CGTU03T','BY102','K885','K889','KI0223',
  'K831','K255','NS305','PA445'
]);

const imbreMappedSkus = new Set(
  Object.values(JSON.parse(readFileSync('./imbretex-code-to-sku.json', 'utf8')))
);

const allProducts = await getAllProductIds(STORE, TOKEN, '');
console.log(`${allProducts.length} produits à auditer\n`);

const issues = [];
let totalOk = 0, totalNoSku = 0, totalHors = 0;

for (const p of allProducts) {
  const variants = await getAllVariants(STORE, TOKEN, p.id);
  const noSku = [];
  const horsFournisseur = [];

  for (const v of variants) {
    if (!v.sku || v.sku.trim() === '') {
      noSku.push(v);
      totalNoSku++;
      continue;
    }
    const ref = v.sku.split(/[-,]/)[0].trim().toUpperCase();
    if (TOPTEX_REFS.has(ref) || imbreMappedSkus.has(v.sku)) {
      totalOk++;
    } else {
      horsFournisseur.push({ sku: v.sku, ref });
      totalHors++;
    }
  }

  if (noSku.length > 0 || horsFournisseur.length > 0) {
    issues.push({ title: p.title, id: p.id, noSku, horsFournisseur });
  }
}

console.log(`✅ OK           : ${totalOk}`);
console.log(`⚠️  Sans SKU     : ${totalNoSku}`);
console.log(`❌ Hors fournisseur: ${totalHors}\n`);

for (const prod of issues) {
  const lines = [];
  if (prod.noSku.length)
    lines.push(`  Sans SKU (${prod.noSku.length}): variant IDs ${prod.noSku.slice(0,3).map(v=>v.id).join(', ')}`);
  if (prod.horsFournisseur.length) {
    const byRef = {};
    for (const v of prod.horsFournisseur) { byRef[v.ref] = (byRef[v.ref]||0)+1; }
    const skuSamples = prod.horsFournisseur.slice(0,3).map(v=>v.sku).join('\n      ');
    lines.push(`  Hors fournisseur (${prod.horsFournisseur.length}) refs: ${JSON.stringify(byRef)}\n      ${skuSamples}`);
  }
  if (lines.length) console.log(`📦 ${prod.title}\n${lines.join('\n')}\n`);
}
