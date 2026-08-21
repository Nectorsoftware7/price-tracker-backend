require("dotenv").config();
const { connectDB, getPool } = require("../config/db");

// One-off: adds products.target_price, the floor a listing is not supposed to go below.
//
// The tracker could say "this price moved" but not "this price is now wrong", which is
// the question someone actually watches for — a marketplace discounting under the agreed
// floor. A number per listing turns a change alert into a breach alert.
//
// Nullable, and null means no floor set: the great majority of listings will never have
// one, and an unset floor must never be read as a floor of zero.
//
// Safe to re-run — the ALTER is guarded.
async function main() {
  await connectDB();
  const pool = getPool();

  const [columns] = await pool.query("SHOW COLUMNS FROM products LIKE 'target_price'");
  if (columns.length) {
    console.log("products.target_price already exists");
  } else {
    await pool.query("ALTER TABLE products ADD COLUMN target_price DECIMAL(10,2) NULL AFTER product_group");
    console.log("added products.target_price");
  }

  const [[counts]] = await pool.query(
    "SELECT COUNT(*) AS total, SUM(target_price IS NOT NULL) AS withTarget FROM products WHERE active = 1"
  );
  console.log(`${counts.withTarget || 0} of ${counts.total} active listings have a floor set`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
