require("dotenv").config();
const path = require("path");
const { google } = require("googleapis");

// One-time (idempotent — safe to re-run) visual formatting pass over the tracker's
// Google Sheet: a bold header row, alternating row banding, and conditional colors on
// every stock-status / price-direction column, reusing the exact palette the dashboard
// itself uses for its status badges (client/src/index.css) so the sheet and the
// dashboard read as the same system instead of two unrelated tools.
//
// Run with: node src/scripts/formatSheets.js
const HEADER_BG = { red: 0x7a / 255, green: 0x00 / 255, blue: 0x40 / 255 }; // --blue-900
const BAND_FIRST = { red: 1, green: 1, blue: 1 }; // white
const BAND_SECOND = { red: 0xff / 255, green: 0xf3 / 255, blue: 0xd9 / 255 }; // --blue-50

const STATUS_COLORS = {
  in_stock: { bg: hex("dcf5e3"), font: hex("1c7a3c") },
  low_stock: { bg: hex("fdecd0"), font: hex("a15c00") },
  out_of_stock: { bg: hex("fbdede"), font: hex("a71d1d") },
  unknown: { bg: hex("fff3d9"), font: hex("9c5b7c") },
  "Price increase": { bg: hex("dcf5e3"), font: hex("1c7a3c") }, // green, matching in_stock — "up"
  "Price decrease": { bg: hex("fbdede"), font: hex("a71d1d") }, // red, matching out_of_stock — "down"
};

function hex(h) {
  const n = parseInt(h, 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

// [tab name, header column count, [ {columnIndex (0-based), values[]} ] for conditional
// coloring, urlColumn index for text wrapping (a raw URL otherwise renders as one
// unbroken line that either overflows into neighboring cells or gets clipped)]
//
// urlColumn is only set on "Price & Stock Changes" — by request, kept to that one tab
// rather than every tab that has a URL column.
const TABS = [
  { name: "Log", columns: 4, colorColumns: [] },
  { name: "Flagged", columns: 7, colorColumns: [{ index: 3, values: ["low_stock", "out_of_stock"] }] }, // Stock
  {
    name: "Price Variation",
    columns: 9,
    colorColumns: [{ index: 6, values: ["in_stock", "low_stock", "out_of_stock", "unknown"] }], // Stock
  },
  {
    name: "Price & Stock Changes",
    columns: 7,
    colorColumns: [
      { index: 3, values: ["Price increase", "Price decrease"] }, // Type
      { index: 5, values: ["in_stock", "low_stock", "out_of_stock", "unknown"] }, // New
    ],
    // No urlColumn — wrapping the URL made every row several lines tall (bad tradeoff
    // for a log meant to be skimmed). Left un-wrapped/overflowing, matching Flagged.
  },
];

const MAX_ROWS = 10000;
// The header fill deliberately reaches past the last real data column (to column Z) —
// a sheet's grid is wider than its data (25 columns on this spreadsheet), and coloring
// only the data columns left the header row visibly cut off partway across, with the
// rest of row 1 showing bare white for the remainder of the viewport.
const HEADER_FILL_COLUMNS = 26;

function headerFormatRequest(sheetId) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADER_FILL_COLUMNS },
      cell: {
        userEnteredFormat: {
          backgroundColor: HEADER_BG,
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
        },
      },
      fields: "userEnteredFormat(backgroundColor,textFormat)",
    },
  };
}

function bandingRequest(sheetId, columnCount) {
  // Starts at row 2 (index 1) — the header keeps its own solid color from
  // headerFormatRequest above, rather than participating in the alternating pattern.
  return {
    addBanding: {
      bandedRange: {
        range: { sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: 0, endColumnIndex: columnCount },
        rowProperties: {
          firstBandColorStyle: { rgbColor: BAND_FIRST },
          secondBandColorStyle: { rgbColor: BAND_SECOND },
        },
      },
    },
  };
}

function urlWrapRequest(sheetId, urlColumn) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: urlColumn, endColumnIndex: urlColumn + 1 },
      cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
      fields: "userEnteredFormat.wrapStrategy",
    },
  };
}

function conditionalFormatRequests(sheetId, columnCount, colorColumns) {
  const requests = [];
  for (const { index, values } of colorColumns) {
    for (const value of values) {
      const colors = STATUS_COLORS[value];
      if (!colors) continue;
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: index, endColumnIndex: index + 1 }],
            booleanRule: {
              condition: { type: "TEXT_EQ", values: [{ userEnteredValue: value }] },
              format: { backgroundColor: colors.bg, textFormat: { foregroundColor: colors.font, bold: true } },
            },
          },
          index: 0,
        },
      });
    }
  }
  return requests;
}

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

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetIdByName = Object.fromEntries(meta.data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));

  // Re-running would otherwise stack duplicate conditional format rules and duplicate
  // banded ranges on every run — clear what this script owns first so it's idempotent.
  const clearRequests = [];
  for (const tab of TABS) {
    const sheetId = sheetIdByName[tab.name];
    if (sheetId === undefined) {
      console.log(`Tab "${tab.name}" not found, skipping.`);
      continue;
    }
    const existing = meta.data.sheets.find((s) => s.properties.sheetId === sheetId);
    (existing.conditionalFormats || []).forEach((_, i) => {
      // Deleting from the end forward keeps earlier indices valid within a single sheet.
      clearRequests.push({ deleteConditionalFormatRule: { sheetId, index: existing.conditionalFormats.length - 1 - i } });
    });
    (existing.bandedRanges || []).forEach((b) => clearRequests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } }));
  }
  if (clearRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: clearRequests } });
    console.log(`Cleared ${clearRequests.length} pre-existing formatting rule(s)/banding.`);
  }

  const requests = [];
  for (const tab of TABS) {
    const sheetId = sheetIdByName[tab.name];
    if (sheetId === undefined) continue;
    requests.push(headerFormatRequest(sheetId));
    requests.push(bandingRequest(sheetId, tab.columns));
    requests.push(...conditionalFormatRequests(sheetId, tab.columns, tab.colorColumns));
    if (tab.urlColumn != null) requests.push(urlWrapRequest(sheetId, tab.urlColumn));
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  console.log(`Applied formatting to ${TABS.filter((t) => sheetIdByName[t.name] !== undefined).length} tab(s), ${requests.length} request(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
