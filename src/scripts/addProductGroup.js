require("dotenv").config();
const { connectDB, getPool } = require("../config/db");

// One-off: adds products.product_group and seeds it from the listing names.
//
// The column exists because nothing else in the schema says that the Flipkart listing
// and the JioMart listing are the same physical product. Comparing prices across
// marketplaces needs that link, and it cannot be inferred reliably — an earlier attempt
// at fuzzy name matching merged "Vitamin C" with "Vitamin B12", put a 30-count next to a
// 120-count, and grouped the kids' "Junior Melatonin" with the adult one. Every one of
// those would have produced a headline price gap that does not exist.
//
// So the seeding here is deliberately conservative: it only groups listings whose names
// are the same once case, punctuation, the brand word and the word "gummies" are taken
// out. That is exact matching in all but formatting, which cannot merge two different
// products — a pack size, a flavour, or the word "junior" all keep them apart.
//
// The cost is coverage, not correctness. Marketplaces that write their own titles —
// Meesho and Purplle mainly — will not match and are left empty for someone to fill in
// from the Products page. An empty group is simply excluded from the comparison, which
// is the right failure: a missing row is honest, a wrong row is not.
//
// Safe to re-run. The ALTER is guarded, and the backfill only touches rows that are
// still NULL, so anything set by hand survives.
function groupKeyFromName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(purna|nector|gummies|gummy)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  await connectDB();
  const pool = getPool();

  const [columns] = await pool.query("SHOW COLUMNS FROM products LIKE 'product_group'");
  if (columns.length === 0) {
    await pool.query("ALTER TABLE products ADD COLUMN product_group VARCHAR(120) NULL AFTER flipkart_sku");
    console.log("added products.product_group");
  } else {
    console.log("products.product_group already exists");
  }

  const [rows] = await pool.query("SELECT id, name, site FROM products WHERE product_group IS NULL");
  const byKey = {};
  for (const row of rows) {
    (byKey[groupKeyFromName(row.name)] ||= []).push(row);
  }

  // A group of one carries no comparison, so leave those unset rather than filling the
  // table with keys that will never pair with anything.
  let updated = 0;
  let groups = 0;
  for (const [key, members] of Object.entries(byKey)) {
    if (new Set(members.map((m) => m.site)).size < 2) continue;
    groups++;
    for (const member of members) {
      await pool.query("UPDATE products SET product_group = ? WHERE id = ?", [key, member.id]);
      updated++;
    }
  }

  console.log(`seeded ${updated} listings across ${groups} multi-marketplace groups`);
  const [[remaining]] = await pool.query(
    "SELECT COUNT(*) AS n FROM products WHERE active = 1 AND product_group IS NULL"
  );
  console.log(`${remaining.n} active listings still ungrouped — set those from the Products page`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
