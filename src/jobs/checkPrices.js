const Product = require("../models/Product");
const PricePoint = require("../models/PricePoint");
const StockEvent = require("../models/StockEvent");
const { getShopifyProduct } = require("../scrapers/shopify");
const { getWooCommerceProduct } = require("../scrapers/woocommerce");
const { getPriceWithBrowser } = require("../scrapers/browserScraper");
const { getPriceWithFetch } = require("../scrapers/fastFetch");
const { sendTelegramMessage } = require("../services/telegram");
const { getExactStockQuantity: getFlipkartExactStock } = require("../services/flipkartAdmin");
const googleSheets = require("../services/googleSheets");

const FLAGGED_STATUSES = ["out_of_stock", "low_stock"];

// JioMart's JSON-LD leaves offers.price blank, so it always needs a CSS selector
// fallback. Rather than making the user supply one, we ship known-good selectors for
// JioMart's product page template so "just paste the URL" keeps working everywhere.
//
// The unscoped ".PriceContainer__currentPrice" class also matches every card in the
// "similar products" carousel further down the page (20+ matches) — .first() usually
// happens to land on the real price since it's earliest in DOM order, but that's not
// guaranteed, and a wrong pick reads as a wild, bogus price swing (e.g. ₹99 -> ₹1949).
// Scoping to .product-description__productInfoContent (the actual product info block,
// which the carousel sits outside of) makes it unambiguous — always exactly 1 match.
const SITE_DEFAULT_SELECTORS = {
  jiomart: {
    priceSelector: ".product-description__productInfoContent .PriceContainer__currentPrice",
    stockSelector: ".product-description__addToCartButton",
  },
};

// Tries the cheap no-browser fetch first and only launches Chromium when that can't
// read the page confidently.
//
// Worth it on two axes: a browser pulls the entire page (scripts, images, fonts,
// trackers — ~240 requests on Snapdeal) when the price was already present in the very
// first response, which on a metered residential proxy is the difference between
// ~2.7 MB and ~55 KB per check; and it turns a 30-100s Chromium run into ~0.3s, which
// is what makes a manual "Check now" feel instant.
//
// getPriceWithFetch returns null (rather than guessing) whenever the page needs real
// rendering, so the browser remains the authority for anything it can't prove.
// Whether the cheap path actually works is a per-site, per-IP fact that can only be
// learned from where production runs — a plain request is far easier to fingerprint as
// a bot than a stealth browser, so a site reachable this way from a laptop may still
// refuse the server. The outcome is recorded on the result (and surfaced by
// "Check now") rather than only logged, so the cheap-path hit rate per site stays
// answerable at any time — that hit rate is what the whole proxy bandwidth budget
// rests on.
async function fetchViaFastPathOrBrowser(url, priceSelector, stockSelector) {
  let fastPath;
  try {
    const fast = await getPriceWithFetch(url);
    if (fast) return { ...fast, fastPath: "hit" };
    fastPath = "declined (no confident price/stock in raw HTML)";
  } catch (err) {
    // Blocked, timed out, unparseable — all just mean "let the browser try".
    fastPath = `failed: ${err.message}`;
  }
  console.log(`[fast-fetch] ${url} -> browser fallback: ${fastPath}`);
  try {
    const result = await getPriceWithBrowser(url, priceSelector, stockSelector);
    return { ...result, fastPath };
  } catch (err) {
    // When the browser fails too, the surfaced error is all anyone sees — without the
    // cheap path's outcome attached, a site that's failing for one reason looks
    // identical to a site failing for another.
    err.message = `${err.message} [fast path: ${fastPath}]`;
    throw err;
  }
}

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
      const result = await fetchViaFastPathOrBrowser(product.url, priceSelector, stockSelector);
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
    case "myntra":
      // No site-specific handling yet — relies on the generic JSON-LD /
      // __NEXT_DATA__ / CSS-selector fallback chain in getPriceWithBrowser.
      // If a site doesn't expose JSON-LD, priceSelector/stockSelector must be
      // supplied per-product (same as any other custom site). Myntra itself is
      // handled earlier in that chain — fastFetch reads its window.__myx payload
      // directly — so this case rarely falls through to an actual browser launch.
      return fetchViaFastPathOrBrowser(product.url, priceSelector, stockSelector);
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
  let newPrice = newStock === "out_of_stock" && oldPrice != null ? oldPrice : scrapedPrice;

  // Advisory-only flag for the same class of bug on sites we haven't hit yet (an
  // ambiguous CSS selector matching an unrelated element). This intentionally does NOT
  // discard/revert the reading — an earlier version did, and a single bad price (from
  // whatever cause) permanently "poisoned" the reference point: every subsequent
  // *correct* reading then looked equally implausible relative to that bad value and
  // got silently reverted forever, locking the product onto the wrong price with no
  // way to recover except a manual DB fix. Just log it for visibility instead.
  const SUSPICIOUS_RATIO = 5;
  if (oldPrice != null && oldPrice > 0 && newPrice !== oldPrice) {
    const ratio = newPrice / oldPrice;
    if (ratio > SUSPICIOUS_RATIO || ratio < 1 / SUSPICIOUS_RATIO) {
      console.warn(`[${product.name}] Suspicious price reading ₹${newPrice} vs last known ₹${oldPrice} (${ratio.toFixed(2)}x) — recording it anyway, but worth a manual look.`);
    }
  }

  // A brand-new product whose very first check finds it already "Currently
  // unavailable" has no price at all yet (not even a prior one to fall back to) —
  // nothing meaningful to record as a price-history point.
  if (newPrice != null) {
    await PricePoint.create(product._id, newPrice);
  }

  const checkedAt = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

  if (oldPrice != null && newPrice !== oldPrice) {
    const direction = newPrice > oldPrice ? "📈 Price increased" : "📉 Price decreased";
    const stats = await getStats24h(product._id);
    await sendTelegramMessage(
      `${direction}\n\n<b>${product.name}</b>\nPlatform: ${product.site}\nOld price: ₹${oldPrice}\nNew price: ₹${newPrice}\n` +
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
      await sendTelegramMessage(`${label}\n\n<b>${product.name}</b>\nPlatform: ${product.site}\n${product.url}\n🕐 ${checkedAt}`);
    } else if (newStock === "in_stock" && oldStock === "out_of_stock") {
      await sendTelegramMessage(`🟢 BACK IN STOCK\n\n<b>${product.name}</b>\nPlatform: ${product.site}\n${product.url}\n🕐 ${checkedAt}`);
    }
  } else if (quantityChanged && oldQuantity != null) {
    // Status stayed the same (still in_stock/low_stock) but the exact quantity moved —
    // this used to only show up as a silent line in the hourly summary count, with no
    // way to tell what actually changed without opening the dashboard.
    const direction = newQuantity > oldQuantity ? "📦 Stock quantity increased" : "📦 Stock quantity dropped";
    await sendTelegramMessage(
      `${direction}: ${oldQuantity} → ${newQuantity}\n\n<b>${product.name}</b>\nPlatform: ${product.site}\n${product.url}\n🕐 ${checkedAt}`
    );
  }

  await Product.recordCheckResult(product._id, { price: newPrice, stock: newStock, stockQuantity: newQuantity });
  console.log(`[${product.name}] price: ${newPrice}, stock: ${newStock}${newQuantity != null ? ` (${newQuantity} units)` : ""}`);

  const priceChanged = oldPrice != null && newPrice !== oldPrice;
  const stockChanged = Boolean(newStock && newStock !== oldStock) || quantityChanged;

  // Flagged/Price Variation/Log are current-state snapshots, rebuilt fresh every sync —
  // none of them keep a record of *when* a specific price move or stock transition
  // happened (a "back in stock" item just disappears from Flagged, with no trace of
  // when it went out or came back). This logs one row per actual event, immediately,
  // as the Telegram alert for it fires — a real timestamped history, not a snapshot.
  // prependRows (not appendRows) so the most recent event reads at the top.
  if (priceChanged || stockChanged) {
    const changeRows = [];
    if (priceChanged) {
      changeRows.push([
        checkedAt,
        product.name,
        product.site,
        newPrice > oldPrice ? "Price increase" : "Price decrease",
        `₹${oldPrice}`,
        `₹${newPrice}`,
        product.url,
      ]);
    }
    if (newStock && newStock !== oldStock) {
      changeRows.push([checkedAt, product.name, product.site, "Stock change", oldStock || "unknown", newStock, product.url]);
    }
    const changesTab = process.env.GOOGLE_SHEETS_CHANGES_TAB || "Price & Stock Changes";
    await googleSheets
      .ensureHeader(changesTab, ["Timestamp", "Name", "Site", "Type", "Old", "New", "URL"])
      .then(() => googleSheets.prependRows(changesTab, changeRows))
      .catch((err) => console.error("Google Sheets change-log append failed:", err.message));
  }

  return { newPrice, priceChanged, stockChanged };
}

// Sites this server's IP can't currently reach at all (blocked outright, or need a
// paid proxy tier we don't have yet) — checked here too, not just in the bulk cron
// loop, so a manual "Check now" on one of these fails in milliseconds with a clear
// reason instead of hanging for 100+ seconds on a scrape that was always going to
// fail. That matters more now than it used to: scrapes are serialized through a
// single in-process queue (to avoid OOM-crashing Render's 512MB instance), so one
// slow doomed check used to block every other check queued behind it too.
function assertSiteReachable(site) {
  const skipSites = (process.env.PRICE_CHECK_SKIP_SITES || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (skipSites.includes(site)) {
    throw new Error(
      `${site} is currently blocked from this server's IP and has no proxy configured — needs a residential proxy/local worker, see PRICE_CHECK_SKIP_SITES.`
    );
  }
}

async function checkOneProduct(product) {
  try {
    assertSiteReachable(product.site);
    let result = await fetchProduct(product);
    // A "Currently unavailable" product genuinely has no price displayed anywhere on
    // the page — null is the correct scrape result there, not a failure. Any other
    // status still requires a real numeric price.
    if (result.stock !== "out_of_stock" && (typeof result.price !== "number" || isNaN(result.price))) {
      throw new Error(`Scraper returned an invalid price: ${result.price}`);
    }

    // Purplle intermittently serves a frozen, byte-identical cached snapshot of the
    // product page even while the live site is clearly out of stock (confirmed via
    // debug logging — a cache-busting query param on the request didn't fix it, since
    // the staleness is server-side, not a CDN edge cache we can bypass client-side).
    // The bad signal only runs one direction (stale cache -> looks in_stock), so only
    // that transition needs a second, independent fetch to confirm before we believe
    // a restock and fire a "BACK IN STOCK" alert.
    if (product.site === "purplle" && product.lastStock === "out_of_stock" && result.stock === "in_stock") {
      const confirm = await fetchProduct(product);
      if (confirm.stock !== "in_stock") {
        console.warn(`[${product.name}] Purplle in_stock reading not confirmed on retry (retry got ${confirm.stock}) — keeping out_of_stock.`);
        result = {
          ...result,
          stock: "out_of_stock",
          stockDetail: { ...result.stockDetail, raw: `Unconfirmed in_stock reading (retry got ${confirm.stock}) — keeping out_of_stock` },
        };
      }
    }

    const { newPrice, priceChanged, stockChanged } = await applyCheckResult(product, result);
    return {
      id: product._id,
      name: product.name,
      site: product.site,
      price: newPrice,
      stock: result.stock,
      quantity: result.stockDetail?.quantity ?? null,
      url: product.url,
      // A brand-new product has no prior reading to compare against (priceChanged/
      // stockChanged are both false on its very first check) — treat that first
      // check as "changed" too, so newly-added products show up in the Log
      // immediately instead of waiting for their first real price/stock move.
      changed: priceChanged || stockChanged || product.lastCheckedAt == null,
      // Which strategy actually produced this reading, and (when the cheap path was
      // skipped) why — see fetchViaFastPathOrBrowser.
      source: result.source,
      fastPath: result.fastPath ?? null,
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
// A per-product "everything I checked" digest was deliberately removed earlier —
// applyCheckResult already sends a focused alert per product exactly when its price
// or stock actually changes, and a blanket listing of every product regardless of
// change was noisy and buried the alerts that matter. But with Render's free tier
// occasionally sleeping/missing a scheduled trigger, there was no way to tell from
// Telegram alone whether the hourly run had actually happened — so this sends one
// short confirmation line per run (not per product) instead.
async function runPriceCheck({ skipSites = [] } = {}) {
  const products = (await Product.findActive()).filter((p) => !skipSites.includes(p.site));
  const results = [];
  for (const product of products) {
    results.push(await checkOneProduct(product));
  }
  await syncGoogleSheets().catch((err) => console.error("Google Sheets sync failed:", err.message));

  const checkedAt = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const failed = results.filter((r) => !r.ok);
  const changed = results.filter((r) => r.ok && r.changed);
  await sendTelegramMessage(
    `⏰ Hourly check ran\n\n${results.length - failed.length}/${results.length} checked, ${changed.length} changed` +
      (failed.length ? `, ${failed.length} failed (${failed.map((f) => f.name).join(", ")})` : "") +
      `\n🕐 ${checkedAt}`
  );

  return results;
}

// Rebuilds the Log, Flagged and Price Variation tabs from scratch every run to reflect
// current state — none of these are an appended history, so they'd grow unbounded
// otherwise. Log is just the plain list of currently-tracked products (id/name/site/
// url); Flagged and Price Variation filter that same list down further.
async function syncGoogleSheets() {
  if (!googleSheets.isConfigured()) return;

  // Only currently-tracked (active) products — a product removed from tracking (or
  // toggled off) shouldn't linger in these snapshot tabs.
  const allProducts = (await Product.findAll()).filter((p) => p.active);

  const logTab = process.env.GOOGLE_SHEETS_LOG_TAB || "Log";
  const logRows = allProducts.map((p) => [p._id, p.name, p.site, p.url]);
  await googleSheets.overwriteSheet(logTab, ["ID", "Product_Name", "Site_Name", "Product_Url"], logRows);

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

  // Out-of-stock/low-stock status belongs to the Flagged tab (its whole purpose is
  // exactly that) — Price Variation's Name column stays plain, no stock-status prefix.
  //
  // One grouped query for every product's 24h stats, not one query per product: the
  // per-product version issued 139 round-trips to a remote MySQL host and measured
  // ~37s against ~205ms for the bulk equivalent — and since this runs after *every*
  // manual "Check now", it, not the scrape, was what made that button feel slow.
  // getStats24h's extra "fall back to the single latest point" behaviour isn't needed
  // here: a product with no points in the window yields min === max either way, and is
  // filtered out below regardless.
  const statsByProduct = await PricePoint.statsForAllProducts(new Date(Date.now() - 24 * 60 * 60 * 1000), new Date());
  const variationRows = [];
  for (const p of allProducts) {
    const stats = statsByProduct[p._id];
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
  const result = await checkOneProduct(product);

  // checkOneProduct catches its own errors (so a bulk run can report a per-product
  // failure and keep going) — but for a single manual "Check now" click, swallowing
  // the failure here just left the row silently unchanged with no feedback at all,
  // looking like the button did nothing. Surface it so the dashboard can show it.
  if (!result.ok) throw new Error(result.error);

  // A real price/stock change already gets its own detailed alert from
  // applyCheckResult. A manual "Check now" click is a deliberate verification action
  // though — send a confirmation for the "nothing changed" case too, so clicking it
  // always gives visible feedback on Telegram instead of silence.
  if (result.ok && !result.changed) {
    const checkedAt = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
    await sendTelegramMessage(
      `🔍 Manual check — no change\n\n<b>${result.name}</b>\nPrice: ₹${result.price}\nStock: ${result.stock}\n🕐 ${checkedAt}`
    );
  }

  // A single manual "Check now" (including the automatic one right after adding a
  // product) previously never touched Sheets — only the bulk hourly/cron run did. A
  // newly-added product would then sit invisible in the Log until the next bulk run.
  await syncGoogleSheets().catch((err) => console.error("Google Sheets sync failed:", err.message));

  // Report how this reading was obtained alongside the product. Not persisted — it
  // describes this one check, not the product — but it's what makes the cheap-path hit
  // rate observable from production rather than inferred from timings.
  const updated = await Product.findById(id);
  return { ...updated, lastCheckSource: result.source ?? null, lastCheckFastPath: result.fastPath ?? null };
}

async function reportCheckResult(id, { price, stock, stockDetail }) {
  const product = await Product.findById(id);
  if (!product) throw new Error("Product not found");
  await applyCheckResult(product, { price, stock, stockDetail });
  return Product.findById(id);
}

module.exports = { runPriceCheck, getStats24h, checkOneProductById, reportCheckResult };
