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
  updateProduct,
  deleteProduct,
  getHistory,
  getStockEvents,
  checkAll,
  reportCheck,
  checkNow,
};
