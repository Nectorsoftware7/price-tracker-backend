require("dotenv").config();
const cron = require("node-cron");

const { connectDB } = require("./config/db");
const app = require("./app");
const { runPriceCheck } = require("./jobs/checkPrices");
const { runAutoReply } = require("./jobs/autoReply");

// A route handler throwing without a try/catch becomes an unhandled rejection, which
// by default crashes the whole process (and the cron scheduler with it). Log instead.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

async function main() {
  await connectDB();

  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`API listening on http://localhost:${port}`));

  const priceCron = process.env.PRICE_CHECK_CRON || "0 */3 * * *";
  const replyCron = process.env.AUTO_REPLY_CRON || "0 */6 * * *";

  const skipSites = (process.env.PRICE_CHECK_SKIP_SITES || "").split(",").map((s) => s.trim()).filter(Boolean);

  cron.schedule(priceCron, () => {
    console.log("Running scheduled price check...");
    runPriceCheck({ skipSites }).catch((err) => console.error("Price check job failed:", err.message));
  });

  cron.schedule(replyCron, () => {
    console.log("Running scheduled auto-reply...");
    runAutoReply().catch((err) => console.error("Auto-reply job failed:", err.message));
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
