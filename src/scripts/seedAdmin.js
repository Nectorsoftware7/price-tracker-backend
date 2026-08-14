require("dotenv").config();
const bcrypt = require("bcryptjs");
const { connectDB } = require("../config/db");
const User = require("../models/User");

// Creates (or updates the password of) the dashboard admin user from env vars.
// Run with: npm run seed:admin
async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const role = process.env.ADMIN_ROLE || "admin";
  if (!username || !password) {
    throw new Error("Set ADMIN_USERNAME and ADMIN_PASSWORD in .env before seeding");
  }

  await connectDB();
  const existing = await User.findByUsername(username);
  const passwordHash = await bcrypt.hash(password, 10);

  if (existing) {
    const { getPool } = require("../config/db");
    await getPool().query("UPDATE users SET password_hash = ?, role = ? WHERE username = ?", [passwordHash, role, username]);
    console.log(`Updated password/role for existing user "${username}" (role: ${role})`);
  } else {
    await User.create({ username, passwordHash, role });
    console.log(`Created user "${username}" (role: ${role})`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
