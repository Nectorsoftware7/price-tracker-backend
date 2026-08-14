const { getPool } = require("../config/db");

function toApiShape(row) {
  if (!row) return null;
  return {
    _id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

async function findByUsername(username) {
  const [rows] = await getPool().query("SELECT * FROM users WHERE username = ?", [username]);
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await getPool().query("SELECT * FROM users WHERE id = ?", [id]);
  return rows[0] || null;
}

async function findAll() {
  const [rows] = await getPool().query("SELECT * FROM users ORDER BY created_at DESC");
  return rows.map(toApiShape);
}

async function create({ username, passwordHash = null, role = "admin", status = "approved" }) {
  const [result] = await getPool().query(
    "INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, ?, ?)",
    [username, passwordHash, role, status]
  );
  const [rows] = await getPool().query("SELECT * FROM users WHERE id = ?", [result.insertId]);
  return toApiShape(rows[0]);
}

async function approve(id, role) {
  await getPool().query("UPDATE users SET role = ?, status = 'approved' WHERE id = ?", [role, id]);
  return toApiShape(await findById(id));
}

async function setActive(id, active) {
  await getPool().query("UPDATE users SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
  return toApiShape(await findById(id));
}

module.exports = { findByUsername, findById, findAll, create, approve, setActive, toApiShape };
