const axios = require("axios");

// Best-effort lookup of exact stock quantity via the WooCommerce Admin REST API.
// Returns null if credentials aren't configured, the product can't be matched, or
// the store hasn't enabled "Track stock quantity" for that product (WooCommerce
// simply doesn't store a number in that case — there's nothing to fetch).
async function getExactStockQuantity(productUrl) {
  const key = process.env.WC_CONSUMER_KEY;
  const secret = process.env.WC_CONSUMER_SECRET;
  if (!key || !secret) return null;

  try {
    const { origin, pathname } = new URL(productUrl);
    const slug = pathname.replace(/\/product\//, "").replace(/\/+$/, "").split("/").pop();
    if (!slug) return null;

    const { data } = await axios.get(`${origin}/wp-json/wc/v3/products`, {
      params: { slug },
      auth: { username: key, password: secret },
      timeout: 10000,
    });

    const product = data[0];
    if (!product) return null;

    return {
      manageStock: Boolean(product.manage_stock),
      quantity: product.manage_stock ? product.stock_quantity : null,
      stockStatus: product.stock_status, // "instock" | "outofstock" | "onbackorder"
    };
  } catch {
    return null;
  }
}

module.exports = { getExactStockQuantity };
