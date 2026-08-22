const { runPriceCheck } = require("../jobs/checkPrices");
const { runAutoReply } = require("../jobs/autoReply");
const { runWeeklyDigest } = require("../jobs/weeklyDigest");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

// Called by an external scheduler (e.g. a Render Cron Job) instead of relying on
// in-process node-cron — on free/sleeping instances the process (and any in-memory
// timers) stops entirely when idle, so scheduled checks silently stop firing. An
// external HTTP-triggered cron wakes the instance on each call instead.
function checkCronSecret(req) {
  const expected = process.env.CRON_SECRET;
  if (expected && req.headers["x-cron-secret"] !== expected) {
    throw new ApiError(401, "Invalid or missing cron secret");
  }
}

const priceCheck = asyncHandler(async (req, res) => {
  checkCronSecret(req);
  const skipSites = (process.env.PRICE_CHECK_SKIP_SITES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const results = await runPriceCheck({ skipSites });
  res.json({ ok: true, checked: results.length });
});

const autoReply = asyncHandler(async (req, res) => {
  checkCronSecret(req);
  await runAutoReply();
  res.json({ ok: true });
});

// Scheduled weekly rather than hourly — point the external scheduler at this one with a
// Monday-morning cron expression.
const weeklyDigest = asyncHandler(async (req, res) => {
  checkCronSecret(req);
  const message = await runWeeklyDigest();
  res.json({ ok: true, message });
});

module.exports = { priceCheck, autoReply, weeklyDigest };
