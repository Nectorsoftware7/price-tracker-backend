require("dotenv").config();
const bcrypt = require("bcryptjs");
const { connectDB, getPool } = require("../config/db");
const User = require("../models/User");

// One-off: adds 'viewer' to the users.role enum (view-only demo/review accounts
// can't be represented by the existing admin/superadmin pair) and creates the
// account. Safe to re-run — ALTER TABLE MODIFY is idempotent and seedOne
// upserts by username. Run with: node src/scripts/createViewerUser.js
const USERNAME = "akashmit8736@gmail.com";
const PASSWORD = "Ashmit8736@";

async function main() {
  await connectDB();
  const pool = getPool();

  await pool.query("ALTER TABLE users MODIFY COLUMN role ENUM('admin', 'superadmin', 'viewer')");

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const existing = await User.findByUsername(USERNAME);
  if (existing) {
    await pool.query(
      "UPDATE users SET password_hash = ?, role = 'viewer', status = 'approved', active = 1 WHERE username = ?",
      [passwordHash, USERNAME]
    );
    console.log(`Updated existing user "${USERNAME}" to role viewer`);
  } else {
    await User.create({ username: USERNAME, passwordHash, role: "viewer", status: "approved" });
    console.log(`Created viewer user "${USERNAME}"`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
