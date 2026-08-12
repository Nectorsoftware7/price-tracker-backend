const { chromium } = require("playwright");
const { classifyStockText } = require("./stockClassifier");

// schema.org Availability URL -> our internal status
const AVAILABILITY_MAP = {
  InStock: "in_stock",
  LimitedAvailability: "low_stock",
  OutOfStock: "out_of_stock",
  SoldOut: "out_of_stock",
  Discontinued: "out_of_stock",
  PreOrder: "unknown",
};

// Most e-commerce sites (Flipkart, Meesho, WooCommerce/Shopify pages too) embed a
// schema.org Product <script type="application/ld+json"> block for SEO. It's far more
// stable than CSS classes, which on React sites like Flipkart are auto-generated and
// change on every rebuild. We prefer this when present, and only fall back to CSS
// selectors when a site doesn't provide it.
async function extractFromJsonLd(page) {
  return page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const offers = item.offers ? (Array.isArray(item.offers) ? item.offers[0] : item.offers) : null;
          // Some sites (JioMart) include an offers.price field that's just an empty
          // string — don't treat that as real data, fall through to CSS selectors.
          if (offers && offers.price !== null && offers.price !== undefined && offers.price !== "" && !isNaN(parseFloat(offers.price))) {
            return { price: offers.price, availability: offers.availability || null };
          }
        }
      } catch {
        // not valid/relevant JSON-LD, skip
      }
    }
    return null;
  });
}

function availabilityUrlToStatus(availability) {
  if (!availability) return null;
  const key = availability.split("/").pop(); // "https://schema.org/InStock" -> "InStock"
  return AVAILABILITY_MAP[key] || "unknown";
}

// Meesho (and other Next.js-rendered sites) embed the full page's server-side props in a
// <script id="__NEXT_DATA__"> JSON blob instead of schema.org JSON-LD. We do a generic
// recursive search for a `price` (number) and an `in_stock` (boolean) key rather than
// hardcoding the exact props path, since that path can differ per site/page template.
async function extractFromNextData(page) {
  return page.evaluate(() => {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el) return null;

    let root;
    try {
      root = JSON.parse(el.textContent);
    } catch {
      return null;
    }

    let price = null;
    let inStock = null;

    function walk(obj, depth) {
      if (!obj || typeof obj !== "object" || depth > 12) return;
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (price === null && key === "price" && typeof val === "number") price = val;
        if (inStock === null && key === "in_stock" && typeof val === "boolean") inStock = val;
        if (price !== null && inStock !== null) return;
        if (val && typeof val === "object") walk(val, depth + 1);
      }
    }
    walk(root, 0);

    if (price === null) return null;
    return { price, inStock };
  });
}

// Purplle's JSON-LD `offers.availability` is unreliable — it kept reporting InStock
// for a listing whose live page clearly showed "This product is out of stock" with a
// "Notify me when in stock" form. The rendered page text is the ground truth here, so
// this overrides whatever JSON-LD/__NEXT_DATA__ claimed when it's present.
async function checkPurplleOutOfStockOverride(page) {
  // The banner renders client-side after the initial DOM load (we navigate with
  // waitUntil: "domcontentloaded" for speed) — poll briefly instead of checking once
  // immediately, but don't block long for the (common) in-stock case where it never appears.
  return page
    .waitForFunction(() => /this product is out of stock/i.test(document.body.innerText || ""), { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
}

async function getPriceWithBrowser(url, priceSelector, stockSelector) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    const jsonLd = await extractFromJsonLd(page);
    if (jsonLd) {
      let status = availabilityUrlToStatus(jsonLd.availability) || "unknown";
      let raw = jsonLd.availability;
      if (url.includes("purplle.com") && (await checkPurplleOutOfStockOverride(page))) {
        status = "out_of_stock";
        raw = "Page text: This product is out of stock";
      }
      return {
        price: parseFloat(jsonLd.price),
        stock: status,
        stockDetail: { status, raw, quantity: null },
        source: "json-ld",
      };
    }

    const nextData = await extractFromNextData(page);
    if (nextData) {
      const status = nextData.inStock == null ? "unknown" : nextData.inStock ? "in_stock" : "out_of_stock";
      return {
        price: parseFloat(nextData.price),
        stock: status,
        stockDetail: { status, raw: null, quantity: null },
        source: "next-data",
      };
    }

    // Fallback: CSS selectors (only reached if the page has no usable JSON-LD or __NEXT_DATA__)
    if (!priceSelector) {
      throw new Error("No JSON-LD or __NEXT_DATA__ price data found on this page, and no priceSelector was configured as a fallback.");
    }

    await page.waitForSelector(priceSelector, { timeout: 15000 });
    const priceText = await page.locator(priceSelector).first().innerText();
    const price = parseFloat(priceText.replace(/[^0-9.]/g, ""));
    if (isNaN(price)) throw new Error(`Could not parse price from "${priceText}"`);

    let stock = { status: "unknown", raw: null, quantity: null };
    if (stockSelector) {
      try {
        const stockText = await page.locator(stockSelector).first().innerText({ timeout: 3000 });
        stock = classifyStockText(stockText);
      } catch {
        stock = { status: "in_stock", raw: null, quantity: null };
      }
    }

    // Some sites (JioMart) keep the "Add to Cart" button's *text* unchanged even when
    // it's disabled — the real signal is a separate "unavailable" message element that
    // only renders when the item can't be added to cart. Treat it as authoritative.
    const unavailableText = await page
      .locator(".product-description__unServicableText")
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => null);
    if (unavailableText) {
      stock = classifyStockText(unavailableText);
    }

    return { price, stock: stock.status, stockDetail: stock, source: "css-selector" };
  } finally {
    await browser.close();
  }
}

module.exports = { getPriceWithBrowser };
