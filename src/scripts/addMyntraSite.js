require("dotenv").config();
const { connectDB, getPool } = require("../config/db");

// One-off: adds 'myntra' to the products.site enum. Safe to re-run — ALTER TABLE
// MODIFY is idempotent. Run with: node src/scripts/addMyntraSite.js
async function main() {
  await connectDB();
  const pool = getPool();

  await pool.query(
    "ALTER TABLE products MODIFY COLUMN site ENUM('shopify', 'woocommerce', 'flipkart', 'meesho', 'jiomart', 'tira', 'nykaa', 'snapdeal', 'purplle', 'myntra') NOT NULL"
  );
  console.log("products.site now accepts 'myntra'");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
