const { getPool } = require("../config/db");

function toApiShape(row) {
  if (!row) return null;
  return { _id: row.id, username: row.username, role: row.role, createdAt: row.created_at };
}

async function findByUsername(username) {
  const [rows] = await getPool().query("SELECT * FROM users WHERE username = ?", [username]);
  return rows[0] || null;
}

async function create({ username, passwordHash, role = "admin" }) {
  const [result] = await getPool().query(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    [username, passwordHash, role]
  );
  const [rows] = await getPool().query("SELECT * FROM users WHERE id = ?", [result.insertId]);
  return toApiShape(rows[0]);
}

module.exports = { findByUsername, create, toApiShape };
