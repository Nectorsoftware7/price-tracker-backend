const { getPool } = require("../config/db");

function toApiShape(row) {
  return {
    _id: row.id,
    source: row.source,
    externalId: row.external_id,
    productName: row.product_name,
    reviewerName: row.reviewer_name,
    rating: row.rating,
    reviewText: row.review_text,
    replyText: row.reply_text,
    repliedAt: row.replied_at,
    createdAt: row.created_at,
  };
}

async function findOne(source, externalId) {
  const [rows] = await getPool().query("SELECT * FROM reviews WHERE source = ? AND external_id = ?", [
    source,
    externalId,
  ]);
  return rows[0] ? toApiShape(rows[0]) : null;
}

async function findAll(limit = 200) {
  const [rows] = await getPool().query("SELECT * FROM reviews ORDER BY created_at DESC LIMIT ?", [limit]);
  return rows.map(toApiShape);
}

async function create({ source, externalId, productName, reviewerName, rating, reviewText, replyText, repliedAt }) {
  await getPool().query(
    `INSERT INTO reviews (source, external_id, product_name, reviewer_name, rating, review_text, reply_text, replied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [source, externalId, productName || null, reviewerName || null, rating ?? null, reviewText || null, replyText || null, repliedAt || null]
  );
}

module.exports = { findOne, findAll, create };
