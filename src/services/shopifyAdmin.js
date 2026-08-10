const axios = require("axios");

// Best-effort lookup of exact stock quantity via the Shopify Admin GraphQL API.
// Returns null if credentials aren't configured or the product can't be matched —
// callers should fall back to the storefront-derived stock status in that case.
async function getExactStockQuantity(productUrl) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!token || !shop) return null;

  try {
    const handle = new URL(productUrl).pathname
      .replace(/\.js$|\.json$/, "")
      .replace(/^\/products\//, "")
      .replace(/\/+$/, "");
    if (!handle) return null;

    const { data } = await axios.post(
      `https://${shop}/admin/api/2024-01/graphql.json`,
      {
        query: `{ productByHandle(handle: "${handle}") { variants(first: 1) { edges { node { inventoryQuantity availableForSale } } } } }`,
      },
      { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" }, timeout: 10000 }
    );

    const variant = data?.data?.productByHandle?.variants?.edges?.[0]?.node;
    if (!variant) return null;

    return { quantity: variant.inventoryQuantity, availableForSale: variant.availableForSale };
  } catch {
    return null;
  }
}

module.exports = { getExactStockQuantity };
