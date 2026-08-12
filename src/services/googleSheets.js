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

async function appendRows(tabName, rows) {
  if (!isConfigured() || rows.length === 0) return;
  const sheets = getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${tabName}!A1`,
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

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tabName}!A1:Z10000` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headerRow, ...rows] },
  });
}

module.exports = { isConfigured, appendRows, overwriteSheet };
