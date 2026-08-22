const express = require("express");
const { priceCheck, autoReply, weeklyDigest } = require("../controllers/cron.controller");

const router = express.Router();

// Public — authenticated by the shared X-Cron-Secret header, not JWT (called by an
// external scheduler, not the dashboard).
router.post("/price-check", priceCheck);
router.post("/auto-reply", autoReply);
router.post("/weekly-digest", weeklyDigest);

module.exports = router;
