const axios = require("axios");

let cachedToken = null;
let cachedTokenExpiresAt = 0;

// Flipkart's OAuth token endpoint expects Basic auth as a GET request (not POST) —
// mismatching that is what looks like an IP-block/generic error page, not an auth error.
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const clientId = process.env.FLIPKART_CLIENT_ID;
  const clientSecret = process.env.FLIPKART_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const { data } = await axios.get("https://api.flipkart.net/oauth-service/oauth/token", {
    params: { grant_type: "client_credentials", scope: "Seller_Api" },
    auth: { username: clientId, password: clientSecret },
  });

  cachedToken = data.access_token;
  // Refresh a bit early rather than exactly at expiry.
  cachedTokenExpiresAt = Date.now() + (data.expires_in - 3600) * 1000;
  return cachedToken;
}

// Best-effort lookup of exact stock quantity via the Flipkart Seller API. `sku` is the
// seller's own SKU ID (from Seller Hub → Listings), not derivable from the public
// product URL — callers must have it configured per product. Returns null if
// credentials/SKU aren't configured or the listing can't be found.
async function getExactStockQuantity(sku) {
  if (!sku) return null;

  try {
    const token = await getAccessToken();
    if (!token) return null;

    const { data } = await axios.get(`https://api.flipkart.net/sellers/listings/v3/${encodeURIComponent(sku)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const listing = data?.available?.[sku];
    if (!listing) return null;

    // NON_FBF listings (seller manages their own stock, not Flipkart's warehouses)
    // often omit `locations` entirely rather than returning an empty array — that's
    // "no location-based inventory data available", not "zero stock". Treating it as
    // zero produced false out-of-stock reports for listings that are genuinely ACTIVE
    // and purchasable. Only trust a computed quantity when `locations` is actually
    // present; otherwise return null so the caller falls back to the page-scraped
    // stock status instead of forcing out_of_stock.
    if (!Array.isArray(listing.locations)) return null;

    const totalInventory = listing.locations.reduce((sum, loc) => sum + (loc.inventory || 0), 0);
    const isActive = listing.listing_status === "ACTIVE";

    return {
      quantity: totalInventory,
      inStock: isActive && totalInventory > 0,
      price: listing.price?.selling_price ?? null,
    };
  } catch {
    return null;
  }
}

module.exports = { getExactStockQuantity };
