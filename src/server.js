require("dotenv").config();

const { connectDB } = require("./config/db");
const app = require("./app");

// A route handler throwing without a try/catch becomes an unhandled rejection, which
// by default crashes the whole process. Log instead.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

// Scheduling lives entirely with the external scheduler (cron-job.org) hitting
// POST /api/cron/price-check and /api/cron/auto-reply — not an in-process node-cron.
// Render's free tier sleeps and kills in-memory timers, which is why the external
// trigger exists at all; running an in-process cron *too* meant that whenever Render
// was awake, both could fire independently around the same time and race on the same
// DB rows (each reading a stale "last known stock" before the other's write landed),
// producing duplicate/contradictory Telegram alerts for the same status change.
async function main() {
  await connectDB();

  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
