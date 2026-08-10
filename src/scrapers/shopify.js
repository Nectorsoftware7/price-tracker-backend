const axios = require("axios");
const { getExactStockQuantity } = require("../services/shopifyAdmin");

// Shopify's .js AJAX endpoint (as opposed to .json) reliably includes `available` —
// some stores/themes strip that field from the plain .json storefront response.
async function getShopifyProduct(url) {
  const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const variant = data.variants[0];
  const price = variant.price / 100; // .js endpoint reports price in the smallest currency unit (paise)

  let stock = variant.available ? "in_stock" : "out_of_stock";
  let quantity = null;

  // If the Admin API is configured for this store, overlay the exact number —
  // otherwise the storefront-derived in/out-of-stock status stands on its own.
  const exact = await getExactStockQuantity(url);
  if (exact) {
    stock = exact.availableForSale ? (exact.quantity != null && exact.quantity <= 5 ? "low_stock" : "in_stock") : "out_of_stock";
    quantity = exact.quantity;
  }

  return {
    price,
    stock,
    stockDetail: {
      status: stock,
      raw: quantity != null ? `${quantity} in stock (Shopify admin)` : null,
      quantity,
    },
  };
}

module.exports = { getShopifyProduct };
