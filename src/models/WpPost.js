const { getPool } = require("../config/db");

function toApiShape(row) {
  return { _id: row.id, siteUrl: row.site_url, postId: row.post_id, productName: row.product_name };
}

async function findAll() {
  const [rows] = await getPool().query("SELECT * FROM wp_posts");
  return rows.map(toApiShape);
}

async function create({ siteUrl, postId, productName }) {
  const [result] = await getPool().query(
    "INSERT INTO wp_posts (site_url, post_id, product_name) VALUES (?, ?, ?)",
    [siteUrl, postId, productName]
  );
  return { _id: result.insertId, siteUrl, postId, productName };
}

async function remove(id) {
  await getPool().query("DELETE FROM wp_posts WHERE id = ?", [id]);
}

module.exports = { findAll, create, remove };
