// Shared price/stock extraction logic, kept transport-agnostic on purpose.
//
// The same product can now be fetched two ways — a plain HTTPS GET (fastFetch.js) or a
// full headless browser (browserScraper.js) — and the two must never disagree about
// which price they pick out of a page, or the tracker would record different values
// depending on which path happened to run. So the *selection rules* live here once;
// each transport only supplies the raw <script> contents it found, using whatever
// mechanism suits it (a DOM query in the browser, a regex over the raw HTML otherwise).

// schema.org Availability URL -> our internal status
const AVAILABILITY_MAP = {
  InStock: "in_stock",
  LimitedAvailability: "low_stock",
  OutOfStock: "out_of_stock",
  SoldOut: "out_of_stock",
  Discontinued: "out_of_stock",
  PreOrder: "unknown",
};

function availabilityUrlToStatus(availability) {
  if (!availability) return null;
  const key = String(availability).split("/").pop(); // "https://schema.org/InStock" -> "InStock"
  return AVAILABILITY_MAP[key] || "unknown";
}

// Given the raw text of every <script type="application/ld+json"> block on a page,
// return the first usable {price, availability}. Some sites (JioMart) include an
// offers.price that's just an empty string — that isn't real data, so it's skipped and
// the caller falls through to its next strategy.
function pickPriceFromJsonLdTexts(texts) {
  for (const text of texts) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      continue; // not valid JSON, skip
    }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const offers = item.offers ? (Array.isArray(item.offers) ? item.offers[0] : item.offers) : null;
      if (
        offers &&
        offers.price !== null &&
        offers.price !== undefined &&
        offers.price !== "" &&
        !isNaN(parseFloat(offers.price))
      ) {
        return { price: offers.price, availability: offers.availability || null };
      }
    }
  }
  return null;
}

// Next.js-rendered sites (Meesho) embed server-side props in a __NEXT_DATA__ blob
// rather than schema.org JSON-LD. A generic recursive search for a numeric `price` and
// a boolean `in_stock` is deliberate — the exact props path differs per site and per
// page template, so hardcoding one would break on any redesign.
function pickPriceFromNextDataText(text) {
  let root;
  try {
    root = JSON.parse(text);
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
}

// Raw-HTML equivalents of the browser's DOM queries, for the no-browser path. Written
// to tolerate attribute order and quote style, since these are hand-written by each
// site rather than normalised by a parser.
const JSON_LD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const NEXT_DATA_RE = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

function jsonLdTextsFromHtml(html) {
  const texts = [];
  let match;
  JSON_LD_RE.lastIndex = 0; // /g regexes carry state between calls
  while ((match = JSON_LD_RE.exec(html)) !== null) texts.push(match[1]);
  return texts;
}

function nextDataTextFromHtml(html) {
  const match = html.match(NEXT_DATA_RE);
  return match ? match[1] : null;
}

module.exports = {
  availabilityUrlToStatus,
  pickPriceFromJsonLdTexts,
  pickPriceFromNextDataText,
  jsonLdTextsFromHtml,
  nextDataTextFromHtml,
};
