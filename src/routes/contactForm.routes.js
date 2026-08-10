const express = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const { listSubmissions, manualReply, wordpressWebhook, shopifyProxy, shopifyDirect } = require("../controllers/contactForm.controller");

const router = express.Router();

router.get("/", requireAuth, listSubmissions);
router.post("/:id/reply", requireAuth, manualReply);

// Public — authenticated by their own shared-secret / HMAC checks, not JWT.
router.post("/wordpress-webhook", wordpressWebhook);
router.post("/shopify-proxy", shopifyProxy);
router.post("/shopify-direct", shopifyDirect);

module.exports = router;
