require("dotenv").config();
const bcrypt = require("bcryptjs");
const { connectDB, getPool } = require("../config/db");
const User = require("../models/User");

// Creates (or updates the password/role of) dashboard users from env vars — never
// commit real credentials to the repo, they live in .env locally and in Render's
// dashboard env vars. Run with: npm run seed:admin
const ACCOUNTS = [
  { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, role: process.env.ADMIN_ROLE || "admin" },
  { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD, role: "superadmin" },
].filter((a) => a.username && a.password);

async function seedOne({ username, password, role }) {
  const existing = await User.findByUsername(username);
  const passwordHash = await bcrypt.hash(password, 10);

  if (existing) {
    await getPool().query(
      "UPDATE users SET password_hash = ?, role = ?, status = 'approved' WHERE username = ?",
      [passwordHash, role, username]
    );
    console.log(`Updated password/role for existing user "${username}" (role: ${role})`);
  } else {
    await User.create({ username, passwordHash, role, status: "approved" });
    console.log(`Created user "${username}" (role: ${role})`);
  }
}

async function main() {
  if (ACCOUNTS.length === 0) {
    throw new Error(
      "Set ADMIN_USERNAME/ADMIN_PASSWORD and/or SUPERADMIN_USERNAME/SUPERADMIN_PASSWORD in .env before seeding"
    );
  }

  await connectDB();
  for (const account of ACCOUNTS) await seedOne(account);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
