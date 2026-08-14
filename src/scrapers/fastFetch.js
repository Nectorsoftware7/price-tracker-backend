const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { HttpsProxyAgent } = require("https-proxy-agent");
const {
  availabilityUrlToStatus,
  pickPriceFromJsonLdTexts,
  pickPriceFromNextDataText,
  jsonLdTextsFromHtml,
  nextDataTextFromHtml,
} = require("./productData");

// A no-browser fetch path, tried before launching Chromium.
//
// Most shopping sites already publish price and availability as a schema.org JSON-LD
// block inside the server-rendered HTML, for search engines. When they do, the *first*
// response already contains everything we need — the browser's remaining ~240 requests
// (scripts, images, fonts, trackers) are fetched, paid for, and discarded unread.
// Measured on live product pages: Snapdeal 2.66 MB -> 55 KB, Purplle 0.60 MB -> 72 KB.
// That ratio is the whole residential-proxy budget, since proxies bill per byte.
//
// It's also dramatically faster (~0.3s vs 30-100s) and uses no meaningful memory, so
// unlike a Chromium launch it doesn't need to be serialized through the scrape queue.

const REQUEST_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

// Only sites confirmed to serve a complete, trustworthy JSON-LD block are worth trying
// this on. Purplle is deliberately excluded: its JSON-LD availability is known to be
// wrong (it reported InStock for a listing whose live page showed "out of stock"), and
// the correction relies on reading client-side-rendered page text that only exists
// after JavaScript runs — which is exactly what this path skips. Trusting the fast
// result there would reintroduce the false "BACK IN STOCK" alerts.
const FAST_FETCH_BLOCKLIST = ["purplle.com"];

function proxyAgentFor(url) {
  if (!process.env.PROXY_SERVER) return undefined;
  const { PROXY_SERVER, PROXY_USERNAME, PROXY_PASSWORD } = process.env;
  // PROXY_SERVER is stored in Playwright's format ("http://host:port"), which carries no
  // credentials — fold them in here, since an HTTP agent expects them in the URL.
  const proxyUrl = new URL(PROXY_SERVER.includes("://") ? PROXY_SERVER : `http://${PROXY_SERVER}`);
  if (PROXY_USERNAME) proxyUrl.username = PROXY_USERNAME;
  if (PROXY_PASSWORD) proxyUrl.password = PROXY_PASSWORD;
  return new HttpsProxyAgent(proxyUrl);
}

// Extra request headers a few sites need to answer usefully. The browser path sets the
// equivalents as real cookies / page options; this mirrors them at the header level.
function extraHeadersFor(url) {
  const headers = {};
  // JioMart gates the whole price section behind a delivery-location prompt for any
  // visitor without one picked. The browser path pre-seeds this same cookie.
  if (url.includes("jiomart.com")) {
    headers.Cookie = `app_location_details=${encodeURIComponent(
      JSON.stringify({ country: "INDIA", country_iso_code: "IN", city: "MUMBAI", pincode: "400001", state: "MAHARASHTRA" })
    )}`;
  }
  return headers;
}

function requestOnce(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error(`Invalid URL: ${url}`));
    }
    const transport = parsed.protocol === "http:" ? http : https;

    const req = transport.get(
      url,
      {
        agent: proxyAgentFor(url),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-IN,en;q=0.9",
          // Ask for compression explicitly: a proxy bills the compressed bytes that
          // actually cross it, so this is a direct cost reduction, not just speed.
          "Accept-Encoding": "gzip, deflate, br",
          ...extraHeadersFor(url),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume(); // drain, otherwise the socket stays open
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
          const next = new URL(res.headers.location, url).toString();
          return resolve(requestOnce(next, redirectsLeft - 1));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const encoding = res.headers["content-encoding"];
          try {
            if (encoding === "gzip") return resolve(zlib.gunzipSync(raw).toString("utf8"));
            if (encoding === "deflate") return resolve(zlib.inflateSync(raw).toString("utf8"));
            if (encoding === "br") return resolve(zlib.brotliDecompressSync(raw).toString("utf8"));
          } catch (err) {
            return reject(new Error(`Failed to decompress ${encoding} response: ${err.message}`));
          }
          resolve(raw.toString("utf8"));
        });
        res.on("error", reject);
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
  });
}

// Returns a scrape result, or null when this page can't be read confidently without a
// browser — never a partial guess. The caller treats null as "fall back to Chromium".
//
// The bar for returning a result is deliberately strict: a real numeric price *and* a
// definite in/out-of-stock signal. An ambiguous result here would be worse than no
// result, because a spurious transition into "unknown" fires a stock-change alert.
async function getPriceWithFetch(url) {
  if (FAST_FETCH_BLOCKLIST.some((host) => url.includes(host))) return null;

  const html = await requestOnce(url, MAX_REDIRECTS);

  const jsonLd = pickPriceFromJsonLdTexts(jsonLdTextsFromHtml(html));
  if (jsonLd) {
    const price = parseFloat(jsonLd.price);
    const status = availabilityUrlToStatus(jsonLd.availability);
    // No availability field, or one we don't recognise — the browser path can still
    // resolve stock from rendered page text, so defer to it rather than guessing.
    if (!isNaN(price) && status && status !== "unknown") {
      return {
        price,
        stock: status,
        stockDetail: { status, raw: jsonLd.availability, quantity: null },
        source: "json-ld-fetch",
      };
    }
  }

  const nextDataText = nextDataTextFromHtml(html);
  if (nextDataText) {
    const nextData = pickPriceFromNextDataText(nextDataText);
    if (nextData && typeof nextData.inStock === "boolean") {
      const price = parseFloat(nextData.price);
      if (!isNaN(price)) {
        const status = nextData.inStock ? "in_stock" : "out_of_stock";
        return {
          price,
          stock: status,
          stockDetail: { status, raw: null, quantity: null },
          source: "next-data-fetch",
        };
      }
    }
  }

  return null;
}

module.exports = { getPriceWithFetch };
