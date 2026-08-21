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

// The first and last price each product carried inside a window, in one query.
//
// min/max cannot answer this: a product that went 100 -> 120 -> 100 has exactly the same
// min and max as one that went 100 -> 120 and stayed there, yet one moved and the other
// did not. Direction needs the endpoints, not the extremes.
//
// Both endpoints come out of a single pass by numbering each product's rows from each
// end and keeping the two that land on 1. id breaks ties so two points sharing a
// timestamp still order deterministically.
async function firstAndLastSince(fromDate) {
  const [rows] = await getPool().query(
    `SELECT product_id, price, rn_asc, rn_desc FROM (
       SELECT product_id, price,
              ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY checked_at ASC, id ASC) AS rn_asc,
              ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY checked_at DESC, id DESC) AS rn_desc
       FROM price_points
       WHERE checked_at >= ?
     ) ranked
     WHERE rn_asc = 1 OR rn_desc = 1`,
    [fromDate]
  );
  const byProduct = {};
  for (const row of rows) {
    const entry = (byProduct[row.product_id] ||= { first: null, last: null });
    if (Number(row.rn_asc) === 1) entry.first = Number(row.price);
    if (Number(row.rn_desc) === 1) entry.last = Number(row.price);
  }
  return byProduct;
}

module.exports = { create, findSince, findBetween, findLatest, statsForAllProducts, findAllSince, firstAndLastSince };
