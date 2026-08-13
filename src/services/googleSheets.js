const path = require("path");
const { google } = require("googleapis");

let sheetsClient = null;

// The service account key is git-ignored (it's a secret), so it only exists on
// machines where it was placed manually — it was never actually deployed to Render,
// which made every Sheets sync from the deployed backend fail silently (caught and
// logged, but never surfaced) while local runs worked fine. GOOGLE_SERVICE_ACCOUNT_JSON
// lets the full key be supplied as a Render environment variable instead of a file.
function getClient() {
  if (sheetsClient) return sheetsClient;

  const authOptions = { scopes: ["https://www.googleapis.com/auth/spreadsheets"] };
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    authOptions.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    authOptions.keyFile = path.join(__dirname, "../config/google-service-account.json");
  }

  const auth = new google.auth.GoogleAuth(authOptions);
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

function isConfigured() {
  return Boolean(process.env.GOOGLE_SHEET_ID);
}

// A1-notation ranges require the sheet name single-quoted whenever it contains a space
// or another character A1 notation treats as special (e.g. "&", ":", "!") — an unquoted
// "Price & Stock Changes!A1:Z1" fails outright ("Unable to parse range"). Tab names with
// only plain word characters happened to work unquoted, which is why this went unnoticed
// until a tab name with "&" was added. A literal single quote inside the name itself
// needs doubling, per A1 notation's escaping rule.
function quoteSheetName(tabName) {
  return `'${tabName.replace(/'/g, "''")}'`;
}

// The Sheets API doesn't auto-create a tab just because something tries to read/write
// a range on it — every call fails with "Unable to parse range" until the tab actually
// exists (discovered when adding a new "Price & Stock Changes" tab in code without ever
// creating it in the spreadsheet itself). Cached for the process lifetime since tabs are
// only ever added, never removed, during normal operation.
let knownTabsCache = null;

async function ensureTabExists(sheets, spreadsheetId, tabName) {
  if (!knownTabsCache) {
    const res = await sheets.spreadsheets.get({ spreadsheetId });
    knownTabsCache = new Set(res.data.sheets.map((s) => s.properties.title));
  }
  if (knownTabsCache.has(tabName)) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  knownTabsCache.add(tabName);
}

// Unlike Flagged/Price Variation (rewritten fresh every run via overwriteSheet, header
// included), the Log tab is append-only — nothing ever re-asserts its header row. If
// row 1 is empty or doesn't match, write it once so a fresh/cleared sheet is always
// self-labeling instead of silently accumulating unlabeled columns.
async function ensureHeader(tabName, headerRow) {
  if (!isConfigured()) return;
  const sheets = getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  await ensureTabExists(sheets, spreadsheetId, tabName);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${quoteSheetName(tabName)}!A1:Z1` });
  const currentHeader = res.data.values?.[0] || [];
  const matches = headerRow.length === currentHeader.length && headerRow.every((h, i) => h === currentHeader[i]);
  if (matches) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(tabName)}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headerRow] },
  });
}

async function appendRows(tabName, rows) {
  if (!isConfigured() || rows.length === 0) return;
  const sheets = getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  await ensureTabExists(sheets, spreadsheetId, tabName);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteSheetName(tabName)}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

// Flagged/variation tabs reflect current state, not a running log — clear the tab and
// rewrite it fresh each run rather than appending forever.
async function overwriteSheet(tabName, headerRow, rows) {
  if (!isConfigured()) return;
  const sheets = getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  await ensureTabExists(sheets, spreadsheetId, tabName);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${quoteSheetName(tabName)}!A1:Z10000` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(tabName)}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headerRow, ...rows] },
  });
}

module.exports = { isConfigured, appendRows, overwriteSheet, ensureHeader };
