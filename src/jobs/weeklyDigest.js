const Product = require("../models/Product");
const PricePoint = require("../models/PricePoint");
const StockEvent = require("../models/StockEvent");
const { sendTelegramMessage } = require("../services/telegram");
const { formatIst } = require("../utils/formatIst");

// A week in one message, for the Monday morning read.
//
// The hourly alerts answer "what just happened"; nobody scrolls back through a week of
// them to answer "how did the week go". This is the other question, and it is the only
// message that goes out when nothing is wrong — which is the point: a quiet week should
// still be visible, not indistinguishable from a broken scheduler.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Long enough that a listing has missed several hourly runs, so this counts real
// breakage rather than one skipped check.
const STALE_HOURS = 12;

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shorten(name, max = 34) {
  const clean = escapeHtml(name);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function buildWeeklyDigest(now = new Date()) {
  const from = new Date(now.getTime() - WEEK_MS);
  const products = await Product.findAll();
  const active = products.filter((p) => p.active);
  const byId = new Map(products.map((p) => [p._id, p]));

  const [bounds, priceChangeCounts, stockChangeCounts] = await Promise.all([
    PricePoint.firstAndLastSince(from),
    PricePoint.changeCountsSince(from),
    StockEvent.changeCountsSince(from),
  ]);

  const outOfStock = active.filter((p) => p.lastStock === "out_of_stock");

  // Where a price ended the week against where it began. A listing that moved and came
  // back is deliberately not in here — it belongs to the churn count below instead.
  const movers = [];
  for (const [id, { first, last }] of Object.entries(bounds)) {
    const product = byId.get(Number(id));
    if (!product || !first || last == null || first === last) continue;
    movers.push({ product, first, last, pct: Math.round(((last - first) / first) * 1000) / 10 });
  }
  movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  const sum = (counts) => Object.values(counts).reduce((total, n) => total + n, 0);

  const churn = Object.entries(stockChangeCounts)
    .map(([id, changes]) => ({ product: byId.get(Number(id)), changes }))
    .filter((row) => row.product)
    .sort((a, b) => b.changes - a.changes);

  // Listings whose last reading is old enough to be untrustworthy. Worth its own line:
  // the dashboard counts them under whatever status they last had, so a stuck listing
  // looks healthy rather than absent.
  const staleCutoff = now.getTime() - STALE_HOURS * 60 * 60 * 1000;
  const stale = active.filter((p) => !p.lastCheckedAt || new Date(p.lastCheckedAt).getTime() < staleCutoff);
  const staleBySite = {};
  for (const p of stale) staleBySite[p.site] = (staleBySite[p.site] || 0) + 1;

  const belowTarget = active.filter(
    (p) => p.targetPrice != null && p.lastPrice != null && p.lastPrice < p.targetPrice
  );

  const lines = [
    "📅 <b>Weekly summary</b>",
    `${formatIst(from)} → ${formatIst(now)}`,
    "",
    `Tracked: <b>${active.length}</b> listings across ${new Set(active.map((p) => p.site)).size} marketplaces`,
    `Out of stock right now: <b>${outOfStock.length}</b>`,
    `Price changes this week: <b>${sum(priceChangeCounts)}</b> across ${Object.keys(priceChangeCounts).length} listings`,
    `Stock changes this week: <b>${sum(stockChangeCounts)}</b> across ${Object.keys(stockChangeCounts).length} listings`,
  ];

  if (movers.length) {
    lines.push("", "<b>Biggest price moves</b>");
    for (const m of movers.slice(0, 5)) {
      const arrow = m.pct > 0 ? "▲" : "▼";
      lines.push(`${arrow} ${shorten(m.product.name)} (${m.product.site}) ₹${m.first} → ₹${m.last}`);
    }
  }

  if (churn.length) {
    lines.push("", "<b>In and out of stock most</b>");
    for (const row of churn.slice(0, 3)) {
      lines.push(`• ${shorten(row.product.name)} (${row.product.site}) — ${row.changes}×`);
    }
  }

  if (belowTarget.length) {
    lines.push("", "<b>Below target price</b>");
    for (const p of belowTarget.slice(0, 5)) {
      lines.push(`⚠️ ${shorten(p.name)} (${p.site}) ₹${p.lastPrice} vs target ₹${p.targetPrice}`);
    }
  }

  if (stale.length) {
    const detail = Object.entries(staleBySite)
      .map(([site, n]) => `${site} ${n}`)
      .join(", ");
    lines.push(
      "",
      `🔧 <b>${stale.length}</b> listings not checked in over ${STALE_HOURS}h — ${detail}`,
      "Their status on the dashboard is whatever it was last time, not what it is now."
    );
  } else {
    lines.push("", "✅ Every listing checked within the last " + STALE_HOURS + "h.");
  }

  return lines.join("\n");
}

async function runWeeklyDigest() {
  const message = await buildWeeklyDigest();
  await sendTelegramMessage(message);
  return message;
}

module.exports = { runWeeklyDigest, buildWeeklyDigest };
