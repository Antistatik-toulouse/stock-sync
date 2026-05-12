/**
 * check-pa438-wine.mjs
 * Vérifie le stock PA438 WINE sur Toptex et les options Shopify
 * Usage: SHOPIFY_TOKEN=xxx node check-pa438-wine.mjs
 */

import { CognitoUserPool, CognitoUser, AuthenticationDetails } from 'amazon-cognito-identity-js';

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
const TOPTEX_API_KEY = 'OrxFxxnX4x5FyhXGkI9dZ3sUtWA5eJaf1q6Bslkf';

async function getJwt() {
  return new Promise((resolve, reject) => {
    const pool = new CognitoUserPool({ UserPoolId: 'eu-central-1_V3BkPppla', ClientId: '14cv2vs23uk99j9hla9iovkm19' });
    const user = new CognitoUser({ Username: 'tofr_antistatik', Pool: pool });
    user.authenticateUser(
      new AuthenticationDetails({ Username: 'tofr_antistatik', Password: 'TOP?bernard0' }),
      { onSuccess: r => resolve(r.getIdToken().getJwtToken()), onFailure: reject }
    );
  });
}

async function gql(query, variables = {}) {
  const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}

console.log('\n🔍 Diagnostic PA438 WINE\n');

// 1. Toptex stock PA438
console.log('1. Stock Toptex PA438...');
const jwt = await getJwt();
const toptexRes = await fetch('https://api.toptex.io/v3/products/inventory?catalog_reference=PA438', {
  headers: { 'x-toptex-authorization': jwt, 'x-api-key': TOPTEX_API_KEY }
});
const toptexData = await toptexRes.json();

// Trouver toutes les couleurs WINE-like
const wineItems = (toptexData.items || []).filter(i => i.color?.toUpperCase().includes('WINE'));
const allColors = [...new Set((toptexData.items || []).map(i => i.color))].sort();

console.log(`   ${toptexData.items?.length || 0} entrées PA438 de Toptex`);
console.log(`   ${allColors.length} couleurs disponibles:`);
allColors.forEach(c => console.log(`     - ${c}`));

if (wineItems.length) {
  console.log('\n   Stock WINE par taille (entrepôt Toptex):');
  wineItems.sort((a, b) => (a.size || '').localeCompare(b.size || '')).forEach(item => {
    const stock = item.warehouses?.find(w => w.id === 'toptex')?.stock || 0;
    const total = item.warehouses?.reduce((s, w) => s + (w.stock || 0), 0) || 0;
    console.log(`     ${(item.size || 'N/A').padEnd(8)} → Toptex: ${String(stock).padStart(5)}  Total: ${total}`);
  });
} else {
  console.log('\n   ⚠️  Aucune couleur WINE trouvée dans Toptex pour PA438');
  console.log('   (les noms de couleurs sont ci-dessus)');
}

// 2. Shopify — variantes PA438 WINE
if (SHOPIFY_TOKEN) {
  console.log('\n2. Variantes Shopify PA438 WINE...');
  const res = await gql(`{
    products(first: 5, query: "sku:PA438*") {
      edges { node {
        title id
        variants(first: 250) { edges { node {
          sku inventoryQuantity
          option1 option2 option3
          selectedOptions { name value }
        }}}
      }}
    }
  }`);

  for (const { node: p } of res.data?.products?.edges || []) {
    const wineVariants = p.variants.edges.map(e => e.node).filter(v =>
      v.option1?.toUpperCase().includes('WINE') || v.option2?.toUpperCase().includes('WINE') ||
      v.option3?.toUpperCase().includes('WINE')
    );
    if (wineVariants.length === 0) continue;
    console.log(`\n   ${p.title}`);
    console.log('   opt1        opt2    opt3    sku                          stock');
    wineVariants.forEach(v => {
      console.log(`   ${String(v.option1||'').padEnd(12)} ${String(v.option2||'').padEnd(8)} ${String(v.option3||'').padEnd(8)} ${String(v.sku||'').padEnd(28)} ${v.inventoryQuantity}`);
    });
  }
}

console.log('\n✅ Diagnostic terminé\n');
