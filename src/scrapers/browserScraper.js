const { chromium } = require("playwright-extra");
const stealthPlugin = require("puppeteer-extra-plugin-stealth")();
const { classifyStockText } = require("./stockClassifier");

// Plain Playwright is trivially fingerprintable as a bot regardless of IP reputation —
// navigator.webdriver=true, missing plugins/mimeTypes, headless-specific canvas/WebGL
// rendering, etc. are all checks anti-bot systems run independently of where the
// request's IP is from. The stealth plugin patches these signals to look like a normal
// Chrome install. This doesn't replace the residential-proxy fix for sites that block
// on IP reputation alone (Tira/Nykaa/Snapdeal's outright 403s look IP-based), but it's
// a prerequisite for telling IP-based blocking apart from fingerprint-based blocking,
// and may fix or reduce blocking on its own for some sites even without a proxy.
chromium.use(stealthPlugin);

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
//
// This banner renders client-side, well after "domcontentloaded" (the event we
// navigate on, for speed on every other site). A short waitForFunction poll here was
// a race: on a slower render (busier network, cold Render instance, etc.) it would
// time out before the banner ever appeared, silently falling back to JSON-LD's wrong
// "InStock" — producing exactly the false "back in stock" alerts this was meant to
// prevent. Waiting for the network to actually go idle first is a real completion
// signal instead of a guessed timeout, so the check only runs once the client-side
// render has had a genuine chance to finish.
async function checkPurplleOutOfStockOverride(page) {
  const idleResult = await page
    .waitForLoadState("networkidle", { timeout: 15000 })
    .then(() => "idle")
    .catch(() => "timeout");

  // Debug: capture what the page actually looked like on this run (site/IP-dependent
  // behavior is suspected — Render's requests may be getting a different response than
  // local ones) so it's visible directly in the API/Telegram output instead of needing
  // Render's own logs.
  const debug = await page.evaluate(() => {
    const text = document.body.innerText || "";
    return {
      textLength: text.length,
      hasOutOfStockText: /this product is out of stock/i.test(text),
      hasNotifyMe: /notify me/i.test(text),
      hasAddToCart: /add to cart|add to bag/i.test(text),
      snippet: text.slice(0, 300).replace(/\s+/g, " "),
    };
  });

  console.log(`[purplle-debug] networkidle=${idleResult} textLength=${debug.textLength} outOfStock=${debug.hasOutOfStockText} notifyMe=${debug.hasNotifyMe} addToCart=${debug.hasAddToCart} snippet="${debug.snippet}"`);

  return { isOutOfStock: debug.hasOutOfStockText || (debug.hasNotifyMe && !debug.hasAddToCart), debug: { idleResult, ...debug } };
}

// Sites that treat our (Render datacenter) IP differently from a normal residential
// visitor — either outright blocking it (Tira/Nykaa return 403 even to a plain curl,
// Meesho similarly), silently serving stale/cached content only to it (Purplle kept
// returning an identical, hours-old "in stock" snapshot regardless of cache-busting
// headers/query params — see checkPurplleOutOfStockOverride's debug logging), or
// server-side geo-IP gating the price section entirely for a non-Indian-resolving IP
// (JioMart — confirmed the location cookie fix alone had zero effect on Render, so
// this is decided before any client-side JS runs, not fixable without changing what
// IP the request comes from). Routing just these through a residential (Indian) proxy
// makes the request look like an ordinary home visitor instead of reworking detection
// per-site.
const PROXY_SITES = ["tira.co", "nykaa.com", "meesho.com", "purplle.com", "snapdeal.com", "jiomart.com"];

function getProxyConfig(url) {
  if (!process.env.PROXY_SERVER) return undefined;
  if (!PROXY_SITES.some((host) => url.includes(host))) return undefined;
  return {
    server: process.env.PROXY_SERVER,
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
  };
}

async function getPriceWithBrowser(url, priceSelector, stockSelector) {
  const browser = await chromium.launch({ headless: true, proxy: getProxyConfig(url) });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    });

    // Purplle's CDN serves stale cached copies of the product page — debug logging
    // showed two consecutive checks 18s apart return fully-rendered but contradictory
    // stock status ("in stock" with Add to Cart present, then "out of stock", then back)
    // with no timeout/block involved. Different requests were landing on different edge
    // cache nodes, some stale. A cache-busting query param + no-cache headers force a
    // fresh fetch from origin instead of a cached edge copy.
    const isPurplle = url.includes("purplle.com");
    if (isPurplle) {
      await page.setExtraHTTPHeaders({ "Cache-Control": "no-cache", Pragma: "no-cache" });
    }

    // JioMart gates the whole price/availability section behind a location prompt
    // ("Enable location Services / Enter pin code...") for any visitor without a
    // delivery location already picked — confirmed via debug logging: Render's fresh,
    // cookie-less session got stuck on that prompt while a session with a location
    // cookie set (e.g. a real browser that already picked one) sees the price
    // normally. Pre-seeding the same cookie the site sets after a manual pincode
    // pick (a fixed Mumbai 400001 — good enough since we only need *a* price, not a
    // hyper-local one) skips the prompt entirely.
    if (url.includes("jiomart.com")) {
      await page.context().addCookies([
        {
          name: "app_location_details",
          value: JSON.stringify({ country: "INDIA", country_iso_code: "IN", city: "MUMBAI", pincode: "400001", state: "MAHARASHTRA" }),
          domain: ".jiomart.com",
          path: "/",
        },
      ]);
    }

    // ScraperAPI (or a similar "unlocker" service) fetches the page from its own pool of
    // rotating/residential IPs and does the bot-detection dodging on its side — we get
    // back plain rendered HTML instead of navigating there ourselves. Loading that HTML
    // into the page via setContent (instead of goto) means every extraction function
    // below (JSON-LD, __NEXT_DATA__, CSS selector) works completely unchanged — only
    // *how the HTML got into the page* differs for these sites.
    const useScraperApi = process.env.SCRAPERAPI_KEY && PROXY_SITES.some((host) => url.includes(host));
    if (useScraperApi) {
      // Snapdeal's CloudFront protection rejected a plain render=true request outright
      // ("Protected domains may require adding premium=true") — the other sites in this
      // heavier-protection bracket (Nykaa/Tira/Meesho, all previously seen returning a
      // 403 rather than degraded/stale content like Purplle/JioMart did) get the same
      // premium routing pre-emptively. JioMart/Purplle already succeeded on the cheaper
      // plain render=true, so they're left off this list to not burn extra credits.
      const needsPremium = ["snapdeal.com", "nykaa.com", "tira.co", "meesho.com"].some((host) => url.includes(host));
      const apiUrl = `https://api.scraperapi.com/?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(url)}&render=true${needsPremium ? "&premium=true" : ""}`;
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error(`ScraperAPI request failed: ${res.status} ${res.statusText}`);
      const html = await res.text();
      await page.setContent(html, { waitUntil: "domcontentloaded" });
    } else {
      const gotoUrl = isPurplle ? `${url}${url.includes("?") ? "&" : "?"}_cb=${Date.now()}` : url;
      await page.goto(gotoUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    }

    let jsonLd = await extractFromJsonLd(page);
    if (!jsonLd) {
      // Render's network/CPU is measurably slower than a home connection — some sites
      // (Snapdeal) inject their JSON-LD block client-side, after JS execution that
      // hasn't finished yet at "domcontentloaded" on a cold/slow run. Confirmed via a
      // live failure: "No JSON-LD ... found" on Render for a page that has it locally.
      // Give the page a bit more time to settle and retry once before falling through
      // to __NEXT_DATA__/CSS selectors.
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      jsonLd = await extractFromJsonLd(page);
    }
    if (jsonLd) {
      let status = availabilityUrlToStatus(jsonLd.availability) || "unknown";
      let raw = jsonLd.availability;
      if (url.includes("purplle.com")) {
        const override = await checkPurplleOutOfStockOverride(page);
        if (override.isOutOfStock) {
          status = "out_of_stock";
          raw = "Page text: This product is out of stock";
        } else {
          // Keep the debug snapshot even when we didn't override, so a wrong
          // "in_stock" reading is diagnosable from the API/DB response itself.
          raw = `${jsonLd.availability} | debug: ${JSON.stringify(override.debug)}`;
        }
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
      const debug = await page.evaluate(() => ({
        title: document.title,
        textLength: (document.body.innerText || "").length,
        snippet: (document.body.innerText || "").slice(0, 300).replace(/\s+/g, " "),
      }));
      throw new Error(`No JSON-LD or __NEXT_DATA__ price data found on this page, and no priceSelector was configured as a fallback. Debug: ${JSON.stringify(debug)}`);
    }

    // 15s was tuned against a home connection — a live Render failure showed JioMart's
    // price selector still not visible after even 25s on Render's network, though the
    // same page loads it well within that on a local run — investigating whether this
    // is genuinely slow rendering or a different (blocked/bot-detected) response.
    try {
      await page.waitForSelector(priceSelector, { timeout: 25000 });
    } catch (err) {
      const debug = await page.evaluate(() => ({
        title: document.title,
        textLength: (document.body.innerText || "").length,
        snippet: (document.body.innerText || "").slice(0, 300).replace(/\s+/g, " "),
      }));
      throw new Error(`${err.message} Debug: ${JSON.stringify(debug)}`);
    }
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
