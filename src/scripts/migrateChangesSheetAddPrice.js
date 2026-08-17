require("dotenv").config();
const path = require("path");
const { google } = require("googleapis");

// One-time migration: the "Price & Stock Changes" tab's Price column moved from last
// (appended after URL, to avoid touching existing rows at all) to just after New/before
// URL (the position actually wanted — URL is long, so Price appended at the end sat off
// the visible area and needed horizontal scrolling to see). Since the tab is otherwise
// append-only, every row written before this column order existed needs rewriting here,
// or its data would silently shift one column left of its header for anything after
// this migration ran. Idempotent — already-8-column rows are left untouched.
//
// Run with: node src/scripts/migrateChangesSheetAddPrice.js
const TAB_NAME = process.env.GOOGLE_SHEETS_CHANGES_TAB || "Price & Stock Changes";
const NEW_HEADER = ["Timestamp", "Name", "Site", "Type", "Old", "New", "Price", "URL"];

async function main() {
  if (!process.env.GOOGLE_SHEET_ID) throw new Error("GOOGLE_SHEET_ID is not set");

  const authOptions = { scopes: ["https://www.googleapis.com/auth/spreadsheets"] };
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    authOptions.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    authOptions.keyFile = path.join(__dirname, "../config/google-service-account.json");
  }
  const auth = new google.auth.GoogleAuth(authOptions);
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${TAB_NAME.replace(/'/g, "''")}'!A1:H10000`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) {
    console.log("Sheet is empty, nothing to migrate.");
    return;
  }

  const [, ...dataRows] = rows;
  let migrated = 0;
  let alreadyDone = 0;
  const rewritten = dataRows.map((row) => {
    // Old shape: [Timestamp, Name, Site, Type, Old, New, URL] (7) or already-migrated
    // 8-column [..., Price, URL] / the short-lived [..., URL, Price] variant.
    if (row.length >= 8) {
      alreadyDone++;
      return row.slice(0, 8);
    }
    const [timestamp, name, site, type, oldVal, newVal, url] = row;
    migrated++;
    return [timestamp ?? "", name ?? "", site ?? "", type ?? "", oldVal ?? "", newVal ?? "", "", url ?? ""];
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${TAB_NAME.replace(/'/g, "''")}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [NEW_HEADER, ...rewritten] },
  });

  console.log(`Migrated ${migrated} row(s), ${alreadyDone} already in the new shape. Header rewritten.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
