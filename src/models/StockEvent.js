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

module.exports = { create, findByProduct };
