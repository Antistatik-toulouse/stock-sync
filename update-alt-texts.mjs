/**
 * update-alt-texts.mjs
 * Génère et applique les alt texts SEO FR/EN sur toutes les images produits Shopify
 * Usage: node update-alt-texts.mjs [--dry-run]
 */

const DRY_RUN = process.argv.includes('--dry-run');
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
if (!SHOPIFY_TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

// Traductions productType FR → EN
const TYPE_EN = {
  'T-shirt':           'customizable T-shirt',
  'T-shirt oversize':  'customizable oversized T-shirt',
  'Sweat à capuche':   'customizable hooded sweatshirt',
  'Sweat à col rond':  'customizable crewneck sweatshirt',
  'Sweat zippé':       'customizable zip-up hoodie',
  'Polo':              'customizable polo shirt',
  'Tote bag':          'customizable tote bag',
  'Casquette':         'customizable cap',
  'Mug':               'customizable ceramic mug',
  '':                  'customizable product',
};

function buildAlt(title, productType, color, imgIndexInColor, totalForColor) {
  const typeEN = TYPE_EN[productType] || 'customizable product';
  const colorPart = color ? ` ${color}` : '';

  // Vue selon la position dans le groupe couleur
  let viewFR = '', viewEN = '';
  if (totalForColor >= 2) {
    if (imgIndexInColor === 0)      { viewFR = ' - vue de face';   viewEN = ' - front view'; }
    else if (imgIndexInColor === 1) { viewFR = ' - vue de dos';    viewEN = ' - back view'; }
    else                            { viewFR = ' - vue détail';    viewEN = ' - detail'; }
  }

  const fr = `${title}${colorPart}${viewFR}`;
  const en = `${typeEN}${colorPart} - Antistatik${viewEN}`;
  return `${fr} | ${en}`.slice(0, 512);
}

import { getAllVariants } from './shopify-utils.mjs';

const API = `https://${SHOPIFY_STORE}/admin/api/2024-01`;

async function restGet(path) {
  const r = await fetch(`${API}${path}`, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
  if (r.status === 429) {
    await new Promise(res => setTimeout(res, parseInt(r.headers.get('Retry-After') || '2') * 1000));
    return restGet(path);
  }
  return { data: await r.json(), link: r.headers.get('link') };
}

async function gql(query, variables = {}) {
  const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}

async function main() {
  console.log(`\nAlt texts SEO Shopify${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   ${new Date().toLocaleString('fr-FR')}\n`);

  // 1. Charger tous les produits avec images via REST paginé
  console.log('1. Chargement des produits...');
  const products = [];
  let path = '/products.json?limit=250&fields=id,title,product_type,images';
  while (path) {
    const { data, link } = await restGet(path);
    products.push(...data.products);
    const next = link?.match(/<([^>]+)>; rel="next"/);
    path = next ? next[1].replace(API, '') : null;
  }
  console.log(`   ${products.length} produits\n`);

  // 2. Générer les alt texts
  console.log('2. Génération des alt texts...');
  const updates = []; // { productId, imageId, alt }

  for (const p of products) {
    // Charger TOUS les variants via REST paginé (pas de limite)
    const variants = await getAllVariants(SHOPIFY_STORE, SHOPIFY_TOKEN, p.id);

    const images = p.images;

    // Map imageId → liste de couleurs (via variants.image_id)
    const imageColorMap = {};
    for (const v of variants) {
      const imgId = v.image_id ? `gid://shopify/MediaImage/${v.image_id}` : null;
      // REST image_id est numérique, on mappe sur l'id REST de l'image
      const restImgId = v.image_id;
      if (!restImgId) continue;
      const color = v.option1 || '';
      if (!imageColorMap[restImgId]) imageColorMap[restImgId] = new Set();
      imageColorMap[restImgId].add(color);
    }

    // Grouper les images par couleur dominante
    const colorToImages = {}; // color → [imageId, ...]
    const processedImages = new Set();

    const productGid = `gid://shopify/Product/${p.id}`;

    // D'abord les images liées à UNE seule couleur
    for (const img of images) {
      const colors = imageColorMap[img.id] ? [...imageColorMap[img.id]] : [];
      if (colors.length === 1) {
        const color = colors[0];
        if (!colorToImages[color]) colorToImages[color] = [];
        colorToImages[color].push(img);
        processedImages.add(img.id);
      }
    }

    // Assigner alt text par groupe couleur
    for (const [color, imgs] of Object.entries(colorToImages)) {
      imgs.forEach((img, idx) => {
        if (img.alt) return; // déjà défini
        const alt = buildAlt(p.title, p.product_type, color, idx, imgs.length);
        const imageGid = `gid://shopify/MediaImage/${img.admin_graphql_api_id?.split('/').pop() || img.id}`;
        updates.push({ productId: productGid, imageId: imageGid, alt });
      });
    }

    // Images restantes (pas liées à une couleur spécifique ou partagées)
    images.filter(img => !processedImages.has(img.id) && !img.alt).forEach((img, idx) => {
      const colors = imageColorMap[img.id] ? [...imageColorMap[img.id]] : [];
      const color = colors.length > 0 ? colors[0] : '';
      const alt = buildAlt(p.title, p.product_type, color, idx, 1);
      const imageGid = `gid://shopify/MediaImage/${img.admin_graphql_api_id?.split('/').pop() || img.id}`;
      updates.push({ productId: productGid, imageId: imageGid, alt });
    });
  }

  console.log(`   ✅ ${updates.length} images à mettre à jour\n`);

  // Aperçu
  console.log('Aperçu (10 premiers) :');
  updates.slice(0, 10).forEach(u => console.log(`  "${u.alt}"`));
  console.log();

  if (DRY_RUN) {
    console.log('⏸  DRY RUN — rien envoyé.');
    return;
  }

  // 3. Appliquer via productImageUpdate
  console.log('3. Mise à jour Shopify...');
  let done = 0, errors = 0;

  for (const u of updates) {
    const res = await gql(`mutation($productId: ID!, $image: ImageInput!) {
      productImageUpdate(productId: $productId, image: $image) {
        image { id altText }
        userErrors { field message }
      }
    }`, { productId: u.productId, image: { id: u.imageId, altText: u.alt } });

    const errs = res.data?.productImageUpdate?.userErrors || [];
    if (errs.length) {
      errors++;
      if (errors <= 5) errs.forEach(e => console.error('  ❌', e.message));
    } else {
      done++;
    }
    process.stdout.write(`\r   ${done + errors}/${updates.length} (${done} OK, ${errors} erreurs)...`);
    // Respecter le rate limit Shopify (2 req/s sur REST, GraphQL plus généreux)
    if ((done + errors) % 50 === 0) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n\n✅ Terminé — ${done} alt texts mis à jour, ${errors} erreurs`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
