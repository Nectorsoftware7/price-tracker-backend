const mysql = require("mysql2/promise");

let pool;

async function connectDB() {
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "localhost",
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "price_tracker",
    waitForConnections: true,
    connectionLimit: 10,
    // DATETIME columns carry no timezone, and this server stores them in UTC (the MySQL
    // host runs UTC, so NOW() is UTC). mysql2 defaults to reading them as the *Node
    // process's* local time, so on a machine set to IST a stored "11:55:30" became
    // 06:25:30Z — every timestamp silently 5:30 in the past, everywhere it surfaced:
    // dashboard "last checked", the Sheet tabs, Telegram alerts, and the 24h/7d/15d
    // windows that decide what counts as recent. "Z" tells it these are already UTC.
    timezone: "Z",
  });

  await pool.query("SELECT 1");
  console.log("MySQL connected");
  return pool;
}

function getPool() {
  if (!pool) throw new Error("DB not connected yet — call connectDB() first");
  return pool;
}

module.exports = { connectDB, getPool };
