const Product = require("../models/Product");
const PricePoint = require("../models/PricePoint");
const StockEvent = require("../models/StockEvent");
const { getShopifyProduct } = require("../scrapers/shopify");
const { getWooCommerceProduct } = require("../scrapers/woocommerce");
const { getPriceWithBrowser } = require("../scrapers/browserScraper");
const { sendTelegramMessage } = require("../services/telegram");
const { getExactStockQuantity: getFlipkartExactStock } = require("../services/flipkartAdmin");
const googleSheets = require("../services/googleSheets");

const FLAGGED_STATUSES = ["out_of_stock", "low_stock"];

// JioMart's JSON-LD leaves offers.price blank, so it always needs a CSS selector
// fallback. Rather than making the user supply one, we ship known-good selectors for
// JioMart's product page template so "just paste the URL" keeps working everywhere.
const SITE_DEFAULT_SELECTORS = {
  jiomart: {
    priceSelector: ".PriceContainer__currentPrice",
    stockSelector: ".product-description__addToCartButton",
  },
};

async function fetchProduct(product) {
  const defaults = SITE_DEFAULT_SELECTORS[product.site];
  const priceSelector = product.priceSelector || defaults?.priceSelector;
  const stockSelector = product.stockSelector || defaults?.stockSelector;

  switch (product.site) {
    case "shopify":
      return getShopifyProduct(product.url);
    case "woocommerce":
      return getWooCommerceProduct(product.url, priceSelector, stockSelector);
    case "flipkart": {
      // Price always comes from the public page — that's what the customer actually
      // pays (it reflects platform-wide sale discounts the Seller API doesn't know
      // about). If a Seller Hub SKU is configured, only the stock quantity is
      // overlaid from the Flipkart Seller API, which is authoritative for that.
      const result = await getPriceWithBrowser(product.url, priceSelector, stockSelector);
      if (product.flipkartSku) {
        const exact = await getFlipkartExactStock(product.flipkartSku);
        if (exact) {
          const status = exact.inStock ? (exact.quantity <= 5 ? "low_stock" : "in_stock") : "out_of_stock";
          return {
            price: result.price,
            stock: status,
            stockDetail: { status, raw: `${exact.quantity} in stock (Flipkart Seller API)`, quantity: exact.quantity },
          };
        }
      }
      return result;
    }
    case "meesho":
    case "jiomart":
    case "tira":
    case "nykaa":
    case "snapdeal":
    case "purplle":
      // No site-specific handling yet — relies on the generic JSON-LD /
      // __NEXT_DATA__ / CSS-selector fallback chain in getPriceWithBrowser.
      // If a site doesn't expose JSON-LD, priceSelector/stockSelector must be
      // supplied per-product (same as any other custom site).
      return getPriceWithBrowser(product.url, priceSelector, stockSelector);
    default:
      throw new Error(`Unknown site type: ${product.site}`);
  }
}

async function getStats24h(productId) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let points = await PricePoint.findSince(productId, cutoff);
  if (points.length === 0) points = await PricePoint.findLatest(productId, 1);
  if (points.length === 0) return null;

  const prices = points.map((p) => p.price);
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
    avg: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100,
    samples: prices.length,
  };
}

// Records a price/stock reading against a product and fires the change alerts.
// Used both for readings this server scraped itself, and for readings reported
// in by an external worker (e.g. a script run on a home PC for sites like Meesho
// that block cloud/data-center IPs).
async function applyCheckResult(product, { price: scrapedPrice, stock: newStock, stockDetail }) {
  const oldPrice = product.lastPrice;
  const oldStock = product.lastStock;
  const oldQuantity = product.lastStockQuantity;
  const newQuantity = stockDetail?.quantity ?? null;

  // Out-of-stock pages often stop rendering the real price widget entirely, which can
  // make a selector-based scraper pick up an unrelated price from elsewhere on the page
  // (e.g. a "similar products" section). Once a product is confirmed unavailable, its
  // price isn't trustworthy — keep the last known real price instead of a bogus one.
  const newPrice = newStock === "out_of_stock" && oldPrice != null ? oldPrice : scrapedPrice;

  await PricePoint.create(product._id, newPrice);

  const checkedAt = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

  if (oldPrice != null && newPrice !== oldPrice) {
    const direction = newPrice > oldPrice ? "📈 Price increased" : "📉 Price decreased";
    const stats = await getStats24h(product._id);
    await sendTelegramMessage(
      `${direction}\n\n<b>${product.name}</b>\nOld price: ₹${oldPrice}\nNew price: ₹${newPrice}\n` +
        (stats ? `Last 24h — min: ₹${stats.min}, max: ₹${stats.max}, avg: ₹${stats.avg}\n` : "") +
        `${product.url}\n🕐 ${checkedAt}`
    );
  }

  // Log a stock event on a status change, OR when we have an exact quantity that
  // moved since the last check — status alone ("in_stock") hides a 45 -> 3 drop.
  const quantityChanged = newQuantity != null && newQuantity !== oldQuantity;
  if ((newStock && newStock !== oldStock) || quantityChanged) {
    await StockEvent.create(product._id, {
      status: newStock,
      raw: stockDetail?.raw ?? null,
      quantity: newQuantity,
    });
  }

  if (newStock && newStock !== oldStock) {
    if (newStock === "out_of_stock" || newStock === "low_stock") {
      const label = newStock === "out_of_stock" ? "🔴 OUT OF STOCK" : "🟠 LOW STOCK";
      await sendTelegramMessage(`${label}\n\n<b>${product.name}</b>\n${product.url}\n🕐 ${checkedAt}`);
    } else if (newStock === "in_stock" && oldStock === "out_of_stock") {
      await sendTelegramMessage(`🟢 BACK IN STOCK\n\n<b>${product.name}</b>\n${product.url}\n🕐 ${checkedAt}`);
    }
  }

  await Product.recordCheckResult(product._id, { price: newPrice, stock: newStock, stockQuantity: newQuantity });
  console.log(`[${product.name}] price: ${newPrice}, stock: ${newStock}${newQuantity != null ? ` (${newQuantity} units)` : ""}`);

  const priceChanged = oldPrice != null && newPrice !== oldPrice;
  const stockChanged = Boolean(newStock && newStock !== oldStock) || quantityChanged;
  return { newPrice, priceChanged, stockChanged };
}

async function checkOneProduct(product) {
  try {
    const result = await fetchProduct(product);
    if (typeof result.price !== "number" || isNaN(result.price)) {
      throw new Error(`Scraper returned an invalid price: ${result.price}`);
    }
    const { newPrice, priceChanged, stockChanged } = await applyCheckResult(product, result);
    return {
      name: product.name,
      site: product.site,
      price: newPrice,
      stock: result.stock,
      quantity: result.stockDetail?.quantity ?? null,
      url: product.url,
      changed: priceChanged || stockChanged,
      ok: true,
    };
  } catch (err) {
    console.error(`Failed to check "${product.name}":`, err.message);
    return { name: product.name, ok: false, error: err.message };
  }
}

// Cloud-side products (Shopify, WooCommerce, Flipkart) are scraped directly. Sites
// this server's IP is blocked from (Meesho) are skipped here and rely on a local
// worker to report results via POST /api/products/:id/report-check instead.
//
// No bulk "everything I checked" Telegram summary here on purpose — applyCheckResult
// already sends a focused alert per product exactly when its price or stock actually
// changes. A blanket hourly digest of every product regardless of change was noisy
// and buried the alerts that matter.
async function runPriceCheck({ skipSites = [] } = {}) {
  const products = (await Product.findActive()).filter((p) => !skipSites.includes(p.site));
  const results = [];
  for (const product of products) {
    results.push(await checkOneProduct(product));
  }
  await syncGoogleSheets(results).catch((err) => console.error("Google Sheets sync failed:", err.message));
  return results;
}

// Appends this run's readings to the Log tab (a running history), then rebuilds the
// Flagged and Price Variation tabs from scratch to reflect current state — those two
// are a snapshot, not a log, so they'd grow unbounded if appended to every hour.
async function syncGoogleSheets(results) {
  if (!googleSheets.isConfigured()) return;

  // Only log rows for products whose price or stock actually moved this run — an
  // unconditional row per product every hour makes the Log tab grow unbounded with
  // mostly-unchanged noise instead of being a useful change history.
  const timestamp = new Date().toISOString();
  const logRows = results
    .filter((r) => r.ok && r.changed)
    .map((r) => [timestamp, r.name, r.site, r.price, r.stock, r.quantity ?? "", r.url]);
  await googleSheets.appendRows(process.env.GOOGLE_SHEETS_LOG_TAB || "Log", logRows);

  // Only currently-tracked (active) products — a product removed from tracking (or
  // toggled off) shouldn't linger in these snapshot tabs.
  const allProducts = (await Product.findAll()).filter((p) => p.active);

  const formatCheckedAt = (p) =>
    p.lastCheckedAt
      ? new Date(p.lastCheckedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })
      : "";

  const flaggedRows = allProducts
    .filter((p) => FLAGGED_STATUSES.includes(p.lastStock))
    .map((p) => [p.name, p.site, p.lastPrice ?? "", p.lastStock, p.lastStockQuantity ?? "", p.url, formatCheckedAt(p)]);
  await googleSheets.overwriteSheet(
    process.env.GOOGLE_SHEETS_FLAGGED_TAB || "Flagged",
    ["Name", "Site", "Price", "Stock", "Quantity", "URL", "Last Checked"],
    flaggedRows
  );

  const variationRows = [];
  for (const p of allProducts) {
    const stats = await getStats24h(p._id);
    if (stats && stats.min !== stats.max) {
      variationRows.push([p.name, p.site, p.lastPrice ?? "", stats.min, stats.max, stats.avg, p.lastStock, p.url, formatCheckedAt(p)]);
    }
  }
  await googleSheets.overwriteSheet(
    process.env.GOOGLE_SHEETS_VARIATION_TAB || "Price Variation",
    ["Name", "Site", "Current", "Min (24h)", "Max (24h)", "Avg (24h)", "Stock", "URL", "Last Checked"],
    variationRows
  );
}

async function checkOneProductById(id) {
  const product = await Product.findById(id);
  if (!product) throw new Error("Product not found");
  await checkOneProduct(product);
  return Product.findById(id);
}

async function reportCheckResult(id, { price, stock, stockDetail }) {
  const product = await Product.findById(id);
  if (!product) throw new Error("Product not found");
  await applyCheckResult(product, { price, stock, stockDetail });
  return Product.findById(id);
}

module.exports = { runPriceCheck, getStats24h, checkOneProductById, reportCheckResult };
