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
