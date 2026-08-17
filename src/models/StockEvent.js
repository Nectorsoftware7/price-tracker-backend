const { getPool } = require("../config/db");

function toApiShape(row) {
  return {
    _id: row.id,
    product: row.product_id,
    status: row.status,
    raw: row.raw,
    quantity: row.quantity,
    checkedAt: row.checked_at,
  };
}

async function create(productId, { status, raw = null, quantity = null }) {
  await getPool().query(
    "INSERT INTO stock_events (product_id, status, raw, quantity) VALUES (?, ?, ?, ?)",
    [productId, status, raw, quantity]
  );
}

async function findByProduct(productId, limit = 50) {
  const [rows] = await getPool().query(
    "SELECT * FROM stock_events WHERE product_id = ? ORDER BY checked_at DESC LIMIT ?",
    [productId, limit]
  );
  return rows.map(toApiShape);
}

// A cross-product feed (dashboard equivalent of the "Price & Stock Changes" Sheet tab)
// — joins in the product's current name/site/url so the frontend doesn't need a
// separate lookup per row.
async function findRecent(limit = 100) {
  const [rows] = await getPool().query(
    `SELECT se.*, p.name AS product_name, p.site AS product_site, p.url AS product_url
     FROM stock_events se
     JOIN products p ON p.id = se.product_id
     ORDER BY se.checked_at DESC
     LIMIT ?`,
    [limit]
  );
  return rows.map((row) => ({
    ...toApiShape(row),
    productName: row.product_name,
    productSite: row.product_site,
    productUrl: row.product_url,
  }));
}

module.exports = { create, findByProduct, findRecent };
