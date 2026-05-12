/**
 * shopify-utils.mjs
 * Helpers Shopify communs — aucune limite de variants (REST paginé)
 */

/**
 * Charge TOUS les variants d'un produit via REST avec pagination.
 * Aucune limite : fonctionne pour 350, 1000, n variants.
 */
export async function getAllVariants(store, token, productId) {
  const numericId = String(productId).split('/').pop();
  let variants = [];
  let url = `/products/${numericId}/variants.json?limit=250`;
  while (url) {
    const res = await fetch(`https://${store}/admin/api/2024-01${url}`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const link = res.headers.get('link');
    const data = await res.json();
    variants.push(...(data.variants || []));
    const next = link?.match(/<([^>]+)>; rel="next"/);
    url = next ? next[1].replace(`https://${store}/admin/api/2024-01`, '') : null;
  }
  return variants;
}

/**
 * Charge tous les produits correspondant à une query GraphQL (paginé).
 * Retourne les GIDs produits + titres.
 */
export async function getAllProductIds(store, token, query) {
  const ids = [];
  let cursor = null;
  do {
    const res = await fetch(`https://${store}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($c: String) {
          products(first: 50, query: "${query}", after: $c) {
            pageInfo { hasNextPage endCursor }
            edges { node { id title } }
          }
        }`,
        variables: { c: cursor }
      })
    }).then(r => r.json());
    for (const { node } of res.data?.products?.edges || []) ids.push(node);
    cursor = res.data?.products?.pageInfo?.hasNextPage
      ? res.data.products.pageInfo.endCursor : null;
  } while (cursor);
  return ids;
}

/**
 * Charge tous les variants de tous les produits matchant une query.
 * Retourne un Map SKU → variant (REST, sans limite).
 */
export async function getAllVariantsBySku(store, token, query) {
  const products = await getAllProductIds(store, token, query);
  const bysku = {};
  for (const p of products) {
    const variants = await getAllVariants(store, token, p.id);
    for (const v of variants) {
      if (v.sku) bysku[v.sku] = v;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return bysku;
}

/**
 * Connecte les inventory items non encore rattachés à un emplacement.
 * Évite l'erreur "not stocked at the location" lors des mises à jour.
 */
export async function ensureStockedAtLocation(store, token, inventoryItemIds, locationNumericId) {
  const toConnect = [];
  for (let i = 0; i < inventoryItemIds.length; i += 50) {
    const chunk = inventoryItemIds.slice(i, i + 50);
    const res = await fetch(
      `https://${store}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${chunk.join(',')}&location_ids=${locationNumericId}`,
      { headers: { 'X-Shopify-Access-Token': token } }
    ).then(r => r.json());
    const connected = new Set((res.inventory_levels || []).map(l => String(l.inventory_item_id)));
    for (const id of chunk) { if (!connected.has(id)) toConnect.push(id); }
  }
  for (const itemId of toConnect) {
    await fetch(`https://${store}/admin/api/2024-01/inventory_levels/connect.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_id: locationNumericId, inventory_item_id: itemId, relocate_if_necessary: false })
    });
    await new Promise(r => setTimeout(r, 200));
  }
  return toConnect.length;
}
