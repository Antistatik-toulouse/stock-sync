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

  // 2. Produits Shopify (sans variantes d'abord)
  const { products } = await shopify('/products.json?limit=250&fields=id,title');
  if (!products) throw new Error('Shopify products invalide');
  console.log(`📦 ${products.length} produits Shopify chargés`);

  // Charge toutes les variantes avec pagination (products.json tronque à 100/produit)
  async function getAllVariants(productId) {
    let variants = [];
    let url = `/products/${productId}/variants.json?limit=250`;
    while (url) {
      const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01${url}`, {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' }
      });
      const linkHeader = res.headers.get('link');
      const data = await res.json();
      variants.push(...(data.variants || []));
      const nextMatch = linkHeader?.match(/<([^>]+)>; rel="next"/);
      url = nextMatch ? nextMatch[1].replace(`https://${SHOPIFY_STORE}/admin/api/2024-01`, '') : null;
    }
    return variants;
  }

  for (const product of products) {
    product.variants = await getAllVariants(product.id);
    await sleep(200);
  }
  const totalVariants = products.reduce((s, p) => s + p.variants.length, 0);
  console.log(`🔢 ${totalVariants} variantes chargées au total`);

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
        // Pour les couleurs bicolores Toptex (ex: "FRENCH NAVY / WHITE"), indexer aussi par la première partie
        const firstPart = color.split(' / ')[0].trim();
        if (firstPart !== color) {
          byColor[firstPart] = (byColor[firstPart] || 0) + stock;
        }
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

  // Noms de couleurs Shopify → noms Toptex, par ref (quand ils diffèrent)
  const COLOR_ALIASES = {
    'BG42':    { 'NAVY': 'FRENCH NAVY' },
    'KP064':   { 'PINK': 'PALE PINK' },
    'NS324':   { 'RASBERRY SORBET': 'RASPBERRY SORBET' },
    'BG125J':  { 'LIME': 'LIME GREEN' },
    'B640':    { 'CHOCOLAT': 'CHOCOLATE', 'NAVY': 'FRENCH NAVY', 'ROYAL BLUE': 'BRIGHT ROYAL' },
    'CGTW02T': { 'MILLENNIAL KHAKY': 'MILLENNIAL KHAKI', 'PISTACHE': 'PISTACHIO' },
  };

  for (const product of products) {
    for (const variant of product.variants) {
      if (!variant.sku) continue;
      const ref = variant.sku.split(/[-,]/)[0].toUpperCase();
      if (!TOPTEX_REFS.has(ref) || !toptexStock[ref]) continue;

      // Couleur depuis option1/option2 — certains produits (NS305) ont option1=taille, option2=couleur
      const SIZE_PATTERN = /^(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|\d{2,3})$/;
      const opt1 = (variant.option1 || '').trim().toUpperCase();
      const opt2 = (variant.option2 || '').trim().toUpperCase();
      const rawColor = SIZE_PATTERN.test(opt1) && opt2 ? opt2 : opt1;
      const color = (COLOR_ALIASES[ref] || {})[rawColor] || rawColor;
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
