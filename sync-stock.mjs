import { CognitoUserPool, CognitoUser, AuthenticationDetails } from 'amazon-cognito-identity-js';

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = 'antistatikstore.myshopify.com';
const TOPTEX_USERNAME = 'tofr_antistatik';
const TOPTEX_PASSWORD = process.env.TOPTEX_PASSWORD;
const TOPTEX_API_KEY = process.env.TOPTEX_API_KEY;

const TOPTEX_REFS = new Set([
  'BG42','KP064','K832','B445','B640','B640B','B15','BG125J','YHVW100',
  'NS208','NS207','K254','K268','PA970','PA169','NS404','NS401','NS403',
  'NS400','NS405','NS402','K381','K357','PA439','PA438','NS307','NS324',
  'NS332','CGTK002','CGTW02T','CGTU03T','BY102','K885','K889','KI0223',
  'K831','K255','NS305','PA445'
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Auth Toptex ---
async function getJwt() {
  return new Promise((resolve, reject) => {
    const pool = new CognitoUserPool({
      UserPoolId: 'eu-central-1_V3BkPppla',
      ClientId: '14cv2vs23uk99j9hla9iovkm19'
    });
    const user = new CognitoUser({ Username: TOPTEX_USERNAME, Pool: pool });
    user.authenticateUser(
      new AuthenticationDetails({ Username: TOPTEX_USERNAME, Password: TOPTEX_PASSWORD }),
      { onSuccess: r => resolve(r.getIdToken().getJwtToken()), onFailure: reject }
    );
  });
}

let _jwt = null;
async function toptex(path) {
  if (!_jwt) _jwt = await getJwt();
  const res = await fetch('https://api.toptex.io' + path, {
    headers: { 'x-toptex-authorization': _jwt, 'x-api-key': TOPTEX_API_KEY }
  });
  return res.json();
}

async function shopify(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01${path}`, opts);
  return res.json();
}

// --- Main ---
async function main() {
  if (!SHOPIFY_TOKEN) throw new Error('Secret SHOPIFY_TOKEN manquant dans GitHub Actions');
  if (!TOPTEX_PASSWORD) throw new Error('Secret TOPTEX_PASSWORD manquant dans GitHub Actions');
  if (!TOPTEX_API_KEY) throw new Error('Secret TOPTEX_API_KEY manquant dans GitHub Actions');

  console.log(`\n🔄 Sync stock démarrée — ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);

  // 1. Location Shopify
  const locRes = await shopify('/locations.json');
  if (!locRes.locations?.length) throw new Error(`Shopify locations invalide: ${JSON.stringify(locRes)}`);
  const locationId = locRes.locations[0].id;
  console.log(`📍 Location Shopify: ${locRes.locations[0].name} (${locationId})`);

  // 2. Produits Shopify
  const { products } = await shopify('/products.json?limit=250&fields=id,title,variants');
  if (!products) throw new Error('Shopify products invalide');
  console.log(`📦 ${products.length} produits Shopify chargés`);

  // 3. Inventaire Toptex par ref
  console.log(`\n📡 Chargement inventaire Toptex...`);
  const toptexStock = {}; // ref -> { COLOR: totalStock }
  for (const ref of TOPTEX_REFS) {
    const data = await toptex(`/v3/products/inventory?catalog_reference=${ref}`);
    if (data.items?.length) {
      const byColor = {};
      for (const item of data.items) {
        const color = item.color?.trim().toUpperCase();
        // Stock direct uniquement (entrepôt Toptex), pas le stock fabricant
        const stock = item.warehouses?.find(w => w.id === 'toptex')?.stock || 0;
        byColor[color] = (byColor[color] || 0) + stock;
      }
      toptexStock[ref] = byColor;
    }
    await sleep(100);
    process.stdout.write('.');
  }
  console.log(`\n✅ Inventaire chargé pour ${Object.keys(toptexStock).length} refs`);

  // 4. Mise à jour stock Shopify
  console.log(`\n📝 Mise à jour des stocks...`);
  let updated = 0, noMatch = 0, zeroStock = 0;

  for (const product of products) {
    for (const variant of product.variants) {
      if (!variant.sku) continue;
      const ref = variant.sku.split(/[-,]/)[0].toUpperCase();
      if (!TOPTEX_REFS.has(ref) || !toptexStock[ref]) continue;

      // Couleur depuis le titre de variante (avant le /)
      const color = variant.title.split('/')[0].trim().toUpperCase();
      const stock = toptexStock[ref][color];

      if (stock === undefined) { noMatch++; continue; }

      await shopify('/inventory_levels/set.json', 'POST', {
        location_id: locationId,
        inventory_item_id: variant.inventory_item_id,
        available: stock
      });

      if (stock === 0) zeroStock++;
      updated++;
      await sleep(300);
    }
  }

  console.log(`
✅ Sync terminée !
   Mises à jour : ${updated}
   Stock à 0    : ${zeroStock}
   Non matchés  : ${noMatch}
  `);
}

main().catch(err => { console.error('❌ Erreur:', err); process.exit(1); });
