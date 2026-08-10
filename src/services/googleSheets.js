const path = require("path");
const { google } = require("googleapis");

let sheetsClient = null;

function getClient() {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "../config/google-service-account.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
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
