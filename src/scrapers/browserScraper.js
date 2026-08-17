const { chromium } = require("playwright-extra");
const stealthPlugin = require("puppeteer-extra-plugin-stealth")();
const { classifyStockText } = require("./stockClassifier");
const {
  availabilityUrlToStatus,
  pickPriceFromJsonLdTexts,
  pickPriceFromNextDataText,
} = require("./productData");

// Plain Playwright is trivially fingerprintable as a bot regardless of IP reputation —
// navigator.webdriver=true, missing plugins/mimeTypes, headless-specific canvas/WebGL
// rendering, etc. are all checks anti-bot systems run independently of where the
// request's IP is from. The stealth plugin patches these signals to look like a normal
// Chrome install. This doesn't replace the residential-proxy fix for sites that block
// on IP reputation alone (Tira/Nykaa/Snapdeal's outright 403s look IP-based), but it's
// a prerequisite for telling IP-based blocking apart from fingerprint-based blocking,
// and may fix or reduce blocking on its own for some sites even without a proxy.
chromium.use(stealthPlugin);

// Most e-commerce sites (Flipkart, Meesho, WooCommerce/Shopify pages too) embed a
// schema.org Product <script type="application/ld+json"> block for SEO. It's far more
// stable than CSS classes, which on React sites like Flipkart are auto-generated and
// change on every rebuild. We prefer this when present, and only fall back to CSS
// selectors when a site doesn't provide it.
//
// The DOM query stays in the page (it also picks up blocks injected client-side, which
// a regex over the served HTML would miss — Snapdeal does exactly that), but it only
// *collects* the raw script text. Deciding which offer counts as a usable price happens
// in productData.js, shared with the no-browser path, so the two can't drift apart.
async function extractFromJsonLd(page) {
  const texts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent)
  );
  return pickPriceFromJsonLdTexts(texts);
}

// Meesho (and other Next.js-rendered sites) embed the full page's server-side props in a
// <script id="__NEXT_DATA__"> JSON blob instead of schema.org JSON-LD.
async function extractFromNextData(page) {
  const text = await page.evaluate(() => {
    const el = document.getElementById("__NEXT_DATA__");
    return el ? el.textContent : null;
  });
  return text ? pickPriceFromNextDataText(text) : null;
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

// Sites confirmed to need help getting past their own bot-detection, from the *browser*
// (not the no-browser fast path, which is what actually gets blocked by IP reputation
// on most of these — a real Playwright+stealth request usually gets through fine):
//   - Purplle: silently serves stale/cached content to a plain request (see
//     checkPurplleOutOfStockOverride's debug logging) — ScraperAPI's own IP pool avoids it.
//   - JioMart: gates the price section server-side behind geo-IP for a non-Indian-
//     resolving IP (the location cookie alone had zero effect on Render).
//   - Meesho: blocks outright at every level tried so far — plain fetch (403), and even
//     a full stealth Playwright browser gets served an inert bot-challenge page (empty
//     render, no product data at all). Only site here still needing ScraperAPI's paid
//     premium tier (or the local-worker fallback) to have a chance.
//
// Tira, Nykaa and Snapdeal were on this list too, routing them through ScraperAPI's
// premium tier — which the account doesn't have, so it just failed outright — when a
// plain stealth Playwright request (no proxy, no ScraperAPI) already gets real data
// from all three (confirmed live against production for Tira: ₹2700, in_stock, via
// json-ld). Keep re-verifying this if one starts failing again — bot detection changes
// over time (this is exactly how Snapdeal ended up here originally).
const PROXY_SITES = ["meesho.com", "purplle.com", "jiomart.com"];

function getProxyConfig(url) {
  if (!process.env.PROXY_SERVER) return undefined;
  if (!PROXY_SITES.some((host) => url.includes(host))) return undefined;
  return {
    server: process.env.PROXY_SERVER,
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
  };
}

// Render's free tier caps the whole instance at 512MB — a single headless Chromium
// instance alone runs 150-300MB+, so two or three overlapping checks (a manual
// "Check now" click landing during the hourly cron run, or a bulk "Check all
// products" click on top of either) were enough to OOM-crash the entire process,
// taking down every in-flight request with it (surfacing as random 502s and checks
// silently failing). A simple in-process queue guarantees only one Chromium instance
// is ever alive at a time, no matter how many check requests arrive concurrently.
let scrapeQueue = Promise.resolve();

async function getPriceWithBrowser(url, priceSelector, stockSelector) {
  const runScrape = () => getPriceWithBrowserUnqueued(url, priceSelector, stockSelector);
  const result = scrapeQueue.then(runScrape, runScrape);
  // Chain the *next* call onto this one's settlement (success or failure) rather than
  // its return value, so a failed scrape doesn't wedge the queue permanently stuck.
  scrapeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function getPriceWithBrowserUnqueued(url, priceSelector, stockSelector) {
  const browser = await chromium.launch({
    headless: true,
    proxy: getProxyConfig(url),
    // --disable-dev-shm-usage: Docker containers default to a tiny 64MB /dev/shm,
    // which Chromium normally uses heavily and crashes/hangs against — this makes it
    // fall back to disk-backed temp files instead. Standard fix for exactly this
    // "works locally, flaky/crashes in a Docker container" Playwright symptom.
    args: ["--disable-dev-shm-usage", "--disable-gpu"],
  });
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
      // Meesho is the one site in PROXY_SITES that's still failing on the cheap
      // plain render=true tier, so it's the only one worth spending premium credits on.
      // JioMart/Purplle already succeed on plain render=true.
      const needsPremium = ["meesho.com"].some((host) => url.includes(host));
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

    // A Flipkart listing with no active seller renders no JSON-LD/price at all and
    // shows a generic "Location not set / Select delivery location" prompt instead —
    // confirmed by loading the exact failing URL directly: no price anywhere on the
    // page, in a real logged-in browser, nothing Render/IP-specific about it. The
    // clearest universal signal that a listing is actually unsellable (rather than
    // this just being a slow/failed render) is the complete absence of Flipkart's
    // buy buttons, which are always present ADD TO CART/BUY NOW when a product can be
    // purchased.
    if (url.includes("flipkart.com")) {
      const hasBuyButton = await page.evaluate(() => {
        const text = (document.body.innerText || "").toUpperCase();
        return text.includes("ADD TO CART") || text.includes("BUY NOW");
      });
      if (!hasBuyButton) {
        return {
          price: null,
          stock: "out_of_stock",
          stockDetail: { status: "out_of_stock", raw: "No buy button / no active seller found", quantity: null },
          source: "css-selector",
        };
      }
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

    // JioMart genuinely renders no price element at all for a product marked
    // "Currently unavailable" — the price selector was never going to appear, and
    // treating that as a scrape *error* (thrown, caught, silently swallowed by
    // checkOneProduct) meant these just sat stuck at "Unknown"/never-checked forever
    // instead of being recorded as out of stock.
    const currentlyUnavailable = await page
      .locator("text=Currently unavailable")
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (currentlyUnavailable) {
      return {
        price: null,
        stock: "out_of_stock",
        stockDetail: { status: "out_of_stock", raw: "Currently unavailable", quantity: null },
        source: "css-selector",
      };
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
