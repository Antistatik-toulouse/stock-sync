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

async function gql(query, variables = {}) {
  const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}

async function main() {
  console.log(`\n🖼  Alt texts SEO Shopify${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   ${new Date().toLocaleString('fr-FR')}\n`);

  // 1. Charger tous les produits avec images + variants
  console.log('1. Chargement des produits...');
  const products = [];
  let cursor = null;
  do {
    const res = await gql(`query($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id title productType
          images(first: 100) { edges { node { id altText } } }
          variants(first: 250) { edges { node {
            selectedOptions { name value }
            image { id }
          } } }
        } }
      }
    }`, { cursor });
    for (const { node: p } of res.data?.products?.edges || []) products.push(p);
    cursor = res.data?.products?.pageInfo?.hasNextPage ? res.data?.products?.pageInfo?.endCursor : null;
  } while (cursor);
  console.log(`   ✅ ${products.length} produits\n`);

  // 2. Générer les alt texts
  console.log('2. Génération des alt texts...');
  const updates = []; // { productId, imageId, alt }

  for (const p of products) {
    const images = p.images.edges.map(e => e.node);

    // Map imageId → liste de couleurs (via variants)
    const imageColorMap = {};
    for (const { node: v } of p.variants.edges) {
      const imgId = v.image?.id;
      if (!imgId) continue;
      const color = v.selectedOptions.find(o => o.name === 'Couleur')?.value || '';
      if (!imageColorMap[imgId]) imageColorMap[imgId] = new Set();
      imageColorMap[imgId].add(color);
    }

    // Grouper les images par couleur dominante
    const colorToImages = {}; // color → [imageId, ...]
    const processedImages = new Set();

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
        if (img.altText) return; // déjà défini
        const alt = buildAlt(p.title, p.productType, color, idx, imgs.length);
        updates.push({ productId: p.id, imageId: img.id, alt });
      });
    }

    // Images restantes (pas liées à une couleur spécifique ou partagées)
    images.filter(img => !processedImages.has(img.id) && !img.altText).forEach((img, idx) => {
      const colors = imageColorMap[img.id] ? [...imageColorMap[img.id]] : [];
      const color = colors.length > 0 ? colors[0] : '';
      const alt = buildAlt(p.title, p.productType, color, idx, 1);
      updates.push({ productId: p.id, imageId: img.id, alt });
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
