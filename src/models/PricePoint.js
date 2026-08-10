const { getPool } = require("../config/db");

function toApiShape(row) {
  return { _id: row.id, product: row.product_id, price: Number(row.price), checkedAt: row.checked_at };
}

async function create(productId, price) {
  await getPool().query("INSERT INTO price_points (product_id, price) VALUES (?, ?)", [productId, price]);
}

async function findSince(productId, sinceDate) {
  const [rows] = await getPool().query(
    "SELECT * FROM price_points WHERE product_id = ? AND checked_at >= ? ORDER BY checked_at ASC",
    [productId, sinceDate]
  );
  return rows.map(toApiShape);
}

async function findBetween(productId, fromDate, toDate) {
  const [rows] = await getPool().query(
    "SELECT * FROM price_points WHERE product_id = ? AND checked_at >= ? AND checked_at <= ? ORDER BY checked_at ASC",
    [productId, fromDate, toDate]
  );
  return rows.map(toApiShape);
}

async function findLatest(productId, limit = 1) {
  const [rows] = await getPool().query(
    "SELECT * FROM price_points WHERE product_id = ? ORDER BY checked_at DESC LIMIT ?",
    [productId, limit]
  );
  return rows.map(toApiShape);
}

module.exports = { create, findSince, findBetween, findLatest };
