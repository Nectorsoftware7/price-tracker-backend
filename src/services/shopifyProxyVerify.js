const crypto = require("crypto");

// Verifies a Shopify App Proxy request is genuinely from Shopify. Shopify signs every
// proxied request by sorting the query params (excluding `signature`), concatenating
// them as "key=value" pairs with no separator, and HMAC-SHA256'ing that string with
// the app's client secret. See: https://shopify.dev/docs/apps/build/online-store/display-dynamic-data#step-2-verify-the-request
function verifyProxySignature(query) {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) return false;

  const { signature, ...rest } = query;
  if (!signature) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(",") : rest[key]}`)
    .join("");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return digest === signature;
}

module.exports = { verifyProxySignature };
