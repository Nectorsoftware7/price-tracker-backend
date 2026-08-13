const { getPool } = require("../config/db");

// Users often paste a product URL with a long tracking query string attached
// (Flipkart's ?pid=...&lid=...&otracker=... can run past our column length, and it's
// not needed to identify or scrape the product anyway) — strip it for every site.
// Seller Hub SKU IDs are usually copy-pasted, which easily drags in surrounding
// whitespace — a leading/trailing space makes the Seller API SKU lookup fail silently
// (404 → treated as "not found"), so trim before it ever reaches a query.
function normalizeSku(sku) {
  if (!sku) return null;
  const trimmed = sku.trim();
  return trimmed || null;
}

function normalizeUrl(site, url) {
  if (!url) return url;
  const stripped = url.split("?")[0];

  // Shopify additionally needs the storefront .js (AJAX) endpoint rather than the
  // human page — some stores/themes omit the `available` field from .json, but .js
  // reliably includes it.
  if (site !== "shopify") return stripped;
  const trimmed = stripped.replace(/\/+$/, "").replace(/\.json$/, "");
  return trimmed.endsWith(".js") ? trimmed : `${trimmed}.js`;
}

function toApiShape(row) {
  if (!row) return null;
  return {
    _id: row.id,
    name: row.name,
    site: row.site,
    url: row.url,
    priceSelector: row.price_selector,
    stockSelector: row.stock_selector,
    flipkartSku: row.flipkart_sku,
    lastPrice: row.last_price != null ? Number(row.last_price) : null,
    lastStock: row.last_stock,
    lastStockQuantity: row.last_stock_quantity,
    lastCheckedAt: row.last_checked_at,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findAll() {
  const [rows] = await getPool().query("SELECT * FROM products ORDER BY created_at DESC");
  return rows.map(toApiShape);
}

async function findActive() {
  const [rows] = await getPool().query("SELECT * FROM products WHERE active = 1");
  return rows.map(toApiShape);
}

async function findById(id) {
  const [rows] = await getPool().query("SELECT * FROM products WHERE id = ?", [id]);
  return toApiShape(rows[0]);
}

async function create({ name, site, url, priceSelector, stockSelector, flipkartSku, active = true }) {
  const [result] = await getPool().query(
    "INSERT INTO products (name, site, url, price_selector, stock_selector, flipkart_sku, active) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [name, site, normalizeUrl(site, url), priceSelector || null, stockSelector || null, normalizeSku(flipkartSku), active ? 1 : 0]
  );
  return findById(result.insertId);
}

async function update(id, fields) {
  if (fields.url !== undefined) {
    const site = fields.site !== undefined ? fields.site : (await findById(id))?.site;
    fields = { ...fields, url: normalizeUrl(site, fields.url) };
  }
  if (fields.flipkartSku !== undefined) {
    fields = { ...fields, flipkartSku: normalizeSku(fields.flipkartSku) };
  }

  const columnMap = {
    name: "name",
    site: "site",
    url: "url",
    priceSelector: "price_selector",
    stockSelector: "stock_selector",
    flipkartSku: "flipkart_sku",
    active: "active",
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(columnMap)) {
    if (fields[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(key === "active" ? (fields[key] ? 1 : 0) : fields[key]);
    }
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  await getPool().query(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`, values);
  return findById(id);
}

async function recordCheckResult(id, { price, stock, stockQuantity }) {
  const sets = ["last_checked_at = NOW()"];
  const values = [];
  if (price != null) {
    sets.push("last_price = ?");
    values.push(price);
  }
  if (stock) {
    sets.push("last_stock = ?");
    values.push(stock);
  }
  if (stockQuantity !== undefined) {
    sets.push("last_stock_quantity = ?");
    values.push(stockQuantity);
  }
  values.push(id);
  await getPool().query(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`, values);
}

async function remove(id) {
  await getPool().query("DELETE FROM products WHERE id = ?", [id]);
}

module.exports = { findAll, findActive, findById, create, update, recordCheckResult, remove, normalizeUrl };
