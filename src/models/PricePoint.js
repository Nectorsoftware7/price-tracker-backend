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

// One aggregate query for every product's stats in a window, instead of the caller
// looping findSince/findBetween per product (the Price & Stock page used to fire one
// HTTP request per tracked product — 139 concurrent requests on a full list, which
// could overwhelm a free-tier instance and looked like the page hanging on "Loading..."
// forever, worse the more times it was re-visited since old in-flight requests weren't
// cancelled). A single GROUP BY gets every product's min/max/avg/count in one round trip.
async function statsForAllProducts(fromDate, toDate) {
  const [rows] = await getPool().query(
    `SELECT product_id, MIN(price) AS min, MAX(price) AS max, AVG(price) AS avg, COUNT(*) AS samples
     FROM price_points
     WHERE checked_at >= ? AND checked_at <= ?
     GROUP BY product_id`,
    [fromDate, toDate]
  );
  const byProduct = {};
  for (const row of rows) {
    byProduct[row.product_id] = {
      min: Number(row.min),
      max: Number(row.max),
      avg: Math.round(Number(row.avg) * 100) / 100,
      samples: row.samples,
    };
  }
  return byProduct;
}

async function findAllSince(fromDate) {
  const [rows] = await getPool().query(
    "SELECT * FROM price_points WHERE checked_at >= ? ORDER BY product_id, checked_at ASC",
    [fromDate]
  );
  return rows.map(toApiShape);
}

module.exports = { create, findSince, findBetween, findLatest, statsForAllProducts, findAllSince };
