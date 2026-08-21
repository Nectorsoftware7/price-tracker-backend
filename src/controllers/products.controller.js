const Product = require("../models/Product");
const PricePoint = require("../models/PricePoint");
const StockEvent = require("../models/StockEvent");
const { checkOneProductById, getStats24h, runPriceCheck, reportCheckResult } = require("../jobs/checkPrices");
const { sendTelegramMessage } = require("../services/telegram");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { istDayKey } = require("../utils/formatIst");

function computeStats(points) {
  if (points.length === 0) return null;
  const prices = points.map((p) => p.price);
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
    avg: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100,
    samples: prices.length,
  };
}

const listProducts = asyncHandler(async (req, res) => {
  res.json(await Product.findAll());
});

// A Shopify link is read through the storefront .js endpoint, which only exists for a
// product page — the model appends ".js" to whatever it is given. Hand it a collection or
// home page and that becomes a URL that simply 404s, and the failure surfaces much later
// as "Request failed with status code 404", which says nothing about the real mistake.
//
// A Shopify product URL always contains /products/<handle>, so the wrong kind of link can
// be turned away here with an explanation instead.
function assertUsableUrl(site, url) {
  if (site !== "shopify" || !url) return;
  if (/\/products\/[^/]+/.test(url)) return;
  throw new ApiError(
    400,
    "That does not look like a Shopify product link. It should contain /products/ — for example https://yourstore.com/products/product-name. " +
      "If the site actually runs on WordPress/WooCommerce, pick WooCommerce as the platform instead."
  );
}

const createProduct = asyncHandler(async (req, res) => {
  assertUsableUrl(req.body.site, req.body.url);
  const product = await Product.create(req.body);
  await sendTelegramMessage(`➕ <b>Added to tracking</b>\n\n<b>${product.name}</b>\nSite: ${product.site}\n${product.url}`);
  res.status(201).json(product);
});

// Matches the frontend's <select> options (Products.jsx) — a bulk-imported "Platform"
// column value (e.g. "Flipkart", pasted straight out of a spreadsheet) needs mapping
// onto these exact internal site keys.
const KNOWN_SITES = ["shopify", "woocommerce", "flipkart", "meesho", "jiomart", "tira", "nykaa", "snapdeal", "purplle", "myntra"];

// Bulk-add many products at once (e.g. pasted straight from a spreadsheet) instead of
// one-by-one through the form. Intentionally does NOT scrape each one immediately —
// with dozens of rows that would be a very slow, easily-timed-out request (each check
// is a full Playwright browser launch) — "Check all products" afterward covers it.
const bulkImportProducts = asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const created = [];
  const skipped = [];

  const existing = await Product.findAll();
  const existingUrls = new Set(existing.map((p) => p.url));

  for (const row of rows) {
    const name = (row.name || "").trim();
    const rawUrl = (row.url || "").trim();
    const site = (row.site || "").trim().toLowerCase();

    if (!name || !rawUrl) {
      skipped.push({ ...row, reason: "Missing name or URL" });
      continue;
    }
    if (!KNOWN_SITES.includes(site)) {
      skipped.push({ ...row, reason: `Unknown platform "${row.site}"` });
      continue;
    }

    // Compare against the *normalized* URL (query string stripped, same as what
    // Product.create stores) — comparing the raw pasted URL let a duplicate slip
    // past this check and hit the DB's unique constraint instead, which aborted the
    // whole remaining batch with a generic 400 rather than being skipped cleanly.
    const normalizedUrl = Product.normalizeUrl(site, rawUrl);
    if (existingUrls.has(normalizedUrl)) {
      skipped.push({ ...row, reason: "Already tracked (duplicate URL)" });
      continue;
    }

    try {
      const product = await Product.create({ name, site, url: rawUrl });
      existingUrls.add(product.url);
      created.push(product);
    } catch (err) {
      // A row-level failure (DB constraint, unexpected data, etc.) shouldn't abort
      // the rest of the batch — record it and keep going.
      skipped.push({ ...row, reason: `Failed: ${err.message}` });
    }
  }

  if (created.length > 0) {
    await sendTelegramMessage(
      `➕ <b>Bulk import</b>\n\n${created.length} product(s) added` +
        (skipped.length ? `, ${skipped.length} skipped` : "") +
        `\n\n${created.map((p) => `• ${p.name} (${p.site})`).join("\n")}`
    );
  }

  res.status(201).json({ created, skipped });
});

const updateProduct = asyncHandler(async (req, res) => {
  if (req.body.url !== undefined) {
    const site = req.body.site ?? (await Product.findById(req.params.id))?.site;
    assertUsableUrl(site, req.body.url);
  }
  const product = await Product.update(req.params.id, req.body);
  if (!product) throw new ApiError(404, "Not found");
  res.json(product);
});

const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  await Product.remove(req.params.id); // ON DELETE CASCADE removes price_points/stock_events too
  if (product) {
    await sendTelegramMessage(`🗑️ <b>Removed from tracking</b>\n\n<b>${product.name}</b>\nSite: ${product.site}`);
  }
  res.status(204).end();
});

// Price history for a chart. Either ?days=7 (relative window, default) or an explicit
// ?from=<ISO date>&to=<ISO date> range to look back further than the rolling window.
const getHistory = asyncHandler(async (req, res) => {
  const { from, to } = req.query;

  if (from && to) {
    const points = await PricePoint.findBetween(req.params.id, new Date(from), new Date(to));
    return res.json({ points, stats24h: computeStats(points) });
  }

  const days = parseInt(req.query.days, 10) || 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const points = await PricePoint.findSince(req.params.id, cutoff);
  const stats = await getStats24h(req.params.id);
  res.json({ points, stats24h: stats });
});

// One call for the price-stats of every tracked product, instead of the Price & Stock
// page firing a separate /history request per product (139 concurrent requests on a
// full list — see PricePoint.statsForAllProducts for why that was a real problem, not
// just something a client-side cache could paper over).
const getAllStats = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 24 * 60 * 60 * 1000);
  res.json(await PricePoint.statsForAllProducts(fromDate, toDate));
});

// Everything the dashboard needs that cannot be derived from the product list alone:
// which prices moved and in which direction, and how many listings were out of stock on
// each day. Both need history, and both are cheap enough to answer together — one round
// trip beats the page firing two.
const getDashboard = asyncHandler(async (req, res) => {
  const requested = parseInt(req.query.days, 10);
  const days = Math.min(Math.max(Number.isFinite(requested) ? requested : 14, 1), 90);
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const products = await Product.findAll();
  const byId = new Map(products.map((p) => [p._id, p]));

  // Movers: endpoints of the window, keeping only products that actually ended
  // somewhere different from where they started.
  const bounds = await PricePoint.firstAndLastSince(from);
  const priceMovers = [];
  for (const [id, { first, last }] of Object.entries(bounds)) {
    const product = byId.get(Number(id));
    if (!product || !first || last == null || first === last) continue;
    priceMovers.push({
      id: product._id,
      name: product.name,
      site: product.site,
      url: product.url,
      first,
      last,
      changePct: Math.round(((last - first) / first) * 1000) / 10,
    });
  }
  priceMovers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

  // Out of stock per day. Events are change-only, so this walks the full history once
  // and carries each product's last known status forward into every later day.
  const events = await StockEvent.findAllOrdered();
  const today = Date.now();
  const status = new Map();
  const stockByDay = [];
  let cursor = 0;

  for (let back = days - 1; back >= 0; back--) {
    const key = istDayKey(new Date(today - back * 24 * 60 * 60 * 1000));
    while (cursor < events.length && istDayKey(events[cursor].checkedAt) <= key) {
      status.set(events[cursor].product, events[cursor].status);
      cursor++;
    }
    let outOfStock = 0;
    let tracked = 0;
    for (const [productId, value] of status) {
      // A product deleted since then should not keep inflating past days.
      if (!byId.has(productId)) continue;
      tracked++;
      if (value === "out_of_stock") outOfStock++;
    }
    // Days before any product had ever been checked carry no information. Emitting
    // them would draw a line sitting flat on zero, which reads as "nothing was out of
    // stock" when it actually means "nothing was known yet".
    if (tracked > 0) stockByDay.push({ date: key, outOfStock, tracked });
  }

  // The same product's price on each marketplace it is listed on.
  //
  // Grouping comes from products.product_group, which a person sets, rather than from
  // matching names here: names differ enough between marketplaces that any automatic
  // rule either misses most of them or merges products that are not the same, and a
  // wrong pairing invents a price gap that does not exist. Ungrouped listings are simply
  // left out — a missing row is honest, a wrong one is not.
  const groups = new Map();
  for (const product of products) {
    if (!product.productGroup || product.lastPrice == null) continue;
    const entry = groups.get(product.productGroup) || { offers: [] };
    entry.offers.push({
      id: product._id,
      site: product.site,
      price: product.lastPrice,
      stock: product.lastStock,
      url: product.url,
      name: product.name,
    });
    groups.set(product.productGroup, entry);
  }

  const marketplacePrices = [];
  for (const [key, { offers }] of groups) {
    // One marketplace is not a comparison.
    if (new Set(offers.map((o) => o.site)).size < 2) continue;
    offers.sort((a, b) => a.price - b.price);
    const low = offers[0].price;
    const high = offers[offers.length - 1].price;
    marketplacePrices.push({
      key,
      // The listing titles differ per marketplace, so the longest is used as the label —
      // it is the one most likely to name the product in full.
      label: offers.reduce((longest, o) => (o.name.length > longest.length ? o.name : longest), ""),
      offers,
      low,
      high,
      spreadPct: low ? Math.round(((high - low) / low) * 1000) / 10 : 0,
    });
  }
  marketplacePrices.sort((a, b) => b.spreadPct - a.spreadPct);

  const ungrouped = products.filter((p) => p.active && !p.productGroup).length;

  res.json({ days, priceMovers, stockByDay, marketplacePrices, ungrouped });
});

const getStockEvents = asyncHandler(async (req, res) => {
  res.json(await StockEvent.findByProduct(req.params.id, 50));
});

const getAllStockEvents = asyncHandler(async (req, res) => {
  const hours = parseInt(req.query.hours, 10) || 24;
  res.json(await StockEvent.findRecent(500, hours));
});

// Manually trigger the same check the hourly cron runs, for all active products at once
// (the cloud-scrapeable sites only — see PRICE_CHECK_SKIP_SITES)
const checkAll = asyncHandler(async (req, res) => {
  const skipSites = (process.env.PRICE_CHECK_SKIP_SITES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const results = await runPriceCheck({ skipSites });
  res.json(results);
});

// Called by a local worker (e.g. a script on a home PC) that scraped a product this
// server's IP is blocked from doing itself (Meesho). Requires a shared secret since
// this endpoint writes data and is reachable from the public internet once deployed.
const reportCheck = asyncHandler(async (req, res) => {
  const expectedSecret = process.env.LOCAL_WORKER_SECRET;
  if (expectedSecret && req.headers["x-worker-secret"] !== expectedSecret) {
    throw new ApiError(401, "Invalid or missing worker secret");
  }
  const { price, stock, stockDetail } = req.body;
  // A genuinely out-of-stock/unavailable listing (e.g. JioMart's "Currently
  // unavailable" state) legitimately has no price anywhere on the page — the same rule
  // checkOneProduct applies to its own scrapes applies here too, otherwise a worker
  // reporting a real out-of-stock reading gets rejected outright.
  if (stock !== "out_of_stock" && (typeof price !== "number" || isNaN(price))) {
    throw new ApiError(400, "price (number) is required unless stock is out_of_stock");
  }
  const product = await reportCheckResult(req.params.id, { price, stock, stockDetail });
  res.json(product);
});

// Manually trigger a check right now (e.g. "Check Now" button in the dashboard)
const checkNow = asyncHandler(async (req, res) => {
  const product = await checkOneProductById(req.params.id);
  res.json(product);
});

module.exports = {
  listProducts,
  createProduct,
  bulkImportProducts,
  updateProduct,
  deleteProduct,
  getHistory,
  getAllStats,
  getDashboard,
  getStockEvents,
  getAllStockEvents,
  checkAll,
  reportCheck,
  checkNow,
};
