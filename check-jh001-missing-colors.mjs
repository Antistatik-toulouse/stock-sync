/**
 * check-jh001-missing-colors.mjs
 * Trouve les variants JH001 sans SKU ou avec SKU inattendu
 * Usage: SHOPIFY_TOKEN=xxx node check-jh001-missing-colors.mjs
 */

const TOKEN = process.env.SHOPIFY_TOKEN;
const STORE = process.env.SHOPIFY_STORE || 'antistatiksamedi.myshopify.com';
if (!TOKEN) throw new Error('SHOPIFY_TOKEN manquant');

const MISSING_COLORS = [
  'CRANBERRY','BURNT ORANGE','DUSTY PINK','PUMPKIN PIE','RED RUST',
  'GINGER BISCUIT','GOLD','SUN YELLOW','SHERBET LEMON','MOCHA BROWN',
  'CARAMEL LATTE','HOT CHOCOLATE','CHOCOLATE FUDGE BROWNIE','DEEP BLACK'
];

async function gql(query, variables = {}) {
  const r = await fetch(`https://${STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}

// Chercher le produit JH001 par titre
async function findJH001Products() {
  const res = await gql(`{
    products(first: 10, query: "title:JH001 OR title:*capuche* OR title:*hoodie*") {
      edges {
        node {
          id
          title
          variants(first: 250) {
            edges {
              node {
                id
                sku
                title
                inventoryQuantity
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }
  }`);

  return res.data?.products?.edges || [];
}

// Chercher aussi par product type ou tag imbretex
async function findByVendor() {
  const res = await gql(`{
    products(first: 10, query: "vendor:*Fruit* OR vendor:*JH*") {
      edges {
        node { id title }
      }
    }
  }`);
  return res.data?.products?.edges || [];
}

console.log('🔍 Recherche produit JH001 dans Shopify...\n');

const products = await findJH001Products();

if (products.length === 0) {
  console.log('Aucun produit trouvé avec "JH001" dans le titre. Essai par vendor...');
  const byVendor = await findByVendor();
  byVendor.forEach(({node}) => console.log(' -', node.title, node.id));
} else {
  for (const { node: p } of products) {
    const variants = p.variants.edges.map(e => e.node);
    console.log(`\n📦 ${p.title} (${p.id})`);
    console.log(`   ${variants.length} variants total`);

    const noSku = variants.filter(v => !v.sku || v.sku.trim() === '');
    const withSku = variants.filter(v => v.sku && v.sku.trim() !== '');
    const zeroStock = variants.filter(v => v.inventoryQuantity === 0);

    console.log(`   SKU renseigné: ${withSku.length}`);
    console.log(`   Sans SKU: ${noSku.length}`);
    console.log(`   Stock = 0: ${zeroStock.length}`);

    // Vérifier les couleurs manquantes
    console.log('\n   Couleurs manquantes trouvées:');
    for (const color of MISSING_COLORS) {
      const colorUpper = color.toUpperCase();
      // Chercher dans les options Color/Couleur
      const found = variants.filter(v => {
        const colorOpt = v.selectedOptions?.find(o =>
          o.name.toLowerCase().includes('color') || o.name.toLowerCase().includes('couleur')
        );
        return colorOpt?.value?.toUpperCase().includes(colorUpper) ||
               colorOpt?.value?.toUpperCase() === colorUpper;
      });
      if (found.length > 0) {
        console.log(`   ✅ ${color}: ${found.length} variants, SKUs: ${found.map(v=>v.sku||'(vide)').slice(0,3).join(', ')}, stock: ${found.map(v=>v.inventoryQuantity).join(', ')}`);
      } else {
        // Chercher dans le titre du variant
        const inTitle = variants.filter(v =>
          v.title?.toUpperCase().includes(colorUpper.split(' ')[0])
        );
        if (inTitle.length > 0) {
          console.log(`   🔶 ${color} (via titre): ${inTitle.slice(0,2).map(v=>v.title+' SKU:'+v.sku).join(', ')}`);
        } else {
          console.log(`   ❌ ${color}: pas trouvé`);
        }
      }
    }

    // Afficher les variants sans SKU
    if (noSku.length > 0) {
      console.log(`\n   Variants sans SKU (${noSku.length}):`);
      noSku.slice(0, 20).forEach(v => {
        const color = v.selectedOptions?.find(o => o.name.toLowerCase().includes('color'))?.value || '?';
        const size = v.selectedOptions?.find(o => o.name.toLowerCase().includes('size') || o.name.toLowerCase().includes('taille'))?.value || '?';
        console.log(`     ${color} / ${size} — stock: ${v.inventoryQuantity}`);
      });
      if (noSku.length > 20) console.log(`     ... et ${noSku.length - 20} autres`);
    }
  }
}
