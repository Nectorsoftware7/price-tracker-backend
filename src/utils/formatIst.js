// Formats an instant as IST without relying on the runtime carrying full ICU data.
//
// toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) is the obvious way to do this and
// works locally — but a Node build without full ICU silently *ignores* the timeZone
// option and formats in UTC instead of throwing. That's what put "18 Aug 2026, 10:08 AM"
// in the Google Sheet while the dashboard, which converts in the browser, showed the same
// instant correctly as 3:38 pm. Same bug reached the Telegram alerts, which are written by
// the same process.
//
// Shifting the epoch and then reading the UTC fields sidesteps the timezone database
// entirely. India has a single fixed +05:30 offset and no DST, so a constant is exact
// here — this would be wrong for a zone with DST, and shouldn't be copied for one.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatIst(value = new Date()) {
  // new Date(null) is the epoch, not an invalid date — a product that has never been
  // checked would otherwise render as "1 Jan 1970, 5:30 am" instead of a blank cell.
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return "";

  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDate();
  const month = MONTHS[ist.getUTCMonth()];
  const year = ist.getUTCFullYear();

  const hours24 = ist.getUTCHours();
  const meridiem = hours24 < 12 ? "am" : "pm";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(ist.getUTCMinutes()).padStart(2, "0");

  return `${day} ${month} ${year}, ${hours12}:${minutes} ${meridiem}`;
}

// The IST calendar day as YYYY-MM-DD. Bucketing by the server's own day would file
// everything after 6:30pm IST under the next date, since the server runs in UTC.
function istDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return "";
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

module.exports = { formatIst, istDayKey };
