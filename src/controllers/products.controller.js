const Product = require("../models/Product");
const PricePoint = require("../models/PricePoint");
const StockEvent = require("../models/StockEvent");
const { checkOneProductById, getStats24h, runPriceCheck, reportCheckResult } = require("../jobs/checkPrices");
const { sendTelegramMessage } = require("../services/telegram");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

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

const createProduct = asyncHandler(async (req, res) => {
  const product = await Product.create(req.body);
  await sendTelegramMessage(`➕ <b>Added to tracking</b>\n\n<b>${product.name}</b>\nSite: ${product.site}\n${product.url}`);
  res.status(201).json(product);
});

// Matches the frontend's <select> options (Products.jsx) — a bulk-imported "Platform"
// column value (e.g. "Flipkart", pasted straight out of a spreadsheet) needs mapping
// onto these exact internal site keys.
const KNOWN_SITES = ["shopify", "woocommerce", "flipkart", "meesho", "jiomart", "tira", "nykaa", "snapdeal", "purplle"];

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

const getStockEvents = asyncHandler(async (req, res) => {
  res.json(await StockEvent.findByProduct(req.params.id, 50));
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
  if (typeof price !== "number" || isNaN(price)) throw new ApiError(400, "price (number) is required");
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
  getStockEvents,
  checkAll,
  reportCheck,
  checkNow,
};
