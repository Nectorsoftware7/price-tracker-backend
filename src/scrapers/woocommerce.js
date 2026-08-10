const axios = require("axios");
const cheerio = require("cheerio");
const { classifyStockText } = require("./stockClassifier");
const { getExactStockQuantity } = require("../services/wooCommerceAdmin");

const AVAILABILITY_MAP = {
  InStock: "in_stock",
  LimitedAvailability: "low_stock",
  OutOfStock: "out_of_stock",
  SoldOut: "out_of_stock",
  Discontinued: "out_of_stock",
  PreOrder: "unknown",
};

// Most WooCommerce sites (via Yoast SEO or WooCommerce's own SEO output) embed a
// schema.org Product <script type="application/ld+json"> block. Prefer that — it needs
// no CSS selector at all — and only fall back to a manual selector if it's missing.
function extractFromJsonLd($) {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const script of scripts) {
    try {
      const data = JSON.parse($(script).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const offers = item.offers ? (Array.isArray(item.offers) ? item.offers[0] : item.offers) : null;
        if (offers && offers.price !== null && offers.price !== undefined && offers.price !== "" && !isNaN(parseFloat(offers.price))) {
          return { price: parseFloat(offers.price), availability: offers.availability || null };
        }
      }
    } catch {
      // not valid/relevant JSON-LD, skip
    }
  }
  return null;
}

function availabilityUrlToStatus(availability) {
  if (!availability) return null;
  const key = availability.split("/").pop();
  return AVAILABILITY_MAP[key] || "unknown";
}

// If the WooCommerce Admin API is configured (WC_CONSUMER_KEY/SECRET) and the store has
// "Track stock quantity" enabled for this product, overlay the exact number/status —
// far more reliable than reading a public page. Otherwise the page-based result stands.
async function applyExactStockIfAvailable(url, stockDetail) {
  const exact = await getExactStockQuantity(url);
  if (!exact) return stockDetail;

  const status =
    exact.stockStatus === "outofstock"
      ? "out_of_stock"
      : exact.manageStock && exact.quantity != null && exact.quantity <= 5
        ? "low_stock"
        : exact.stockStatus === "instock"
          ? "in_stock"
          : stockDetail.status;

  return {
    status,
    raw: exact.manageStock && exact.quantity != null ? `${exact.quantity} in stock (WooCommerce admin)` : stockDetail.raw,
    quantity: exact.manageStock ? exact.quantity : stockDetail.quantity,
  };
}

async function getWooCommerceProduct(url, priceSelector, stockSelector) {
  const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const $ = cheerio.load(data);

  const jsonLd = extractFromJsonLd($);
  if (jsonLd) {
    const status = availabilityUrlToStatus(jsonLd.availability);
    const stockDetail = await applyExactStockIfAvailable(url, {
      status: status || "unknown",
      raw: jsonLd.availability,
      quantity: null,
    });
    return { price: jsonLd.price, stock: stockDetail.status, stockDetail };
  }

  if (!priceSelector) {
    throw new Error("No JSON-LD price data found on this page, and no priceSelector was configured as a fallback.");
  }

  const priceText = $(priceSelector).first().text();
  const price = parseFloat(priceText.replace(/[^0-9.]/g, ""));
  if (isNaN(price)) throw new Error(`Could not parse price from selector "${priceSelector}"`);

  let stock = { status: "unknown", raw: null, quantity: null };
  if (stockSelector) {
    const stockText = $(stockSelector).first().text().trim();
    stock = classifyStockText(stockText);
  }
  stock = await applyExactStockIfAvailable(url, stock);

  return { price, stock: stock.status, stockDetail: stock };
}

module.exports = { getWooCommerceProduct };
