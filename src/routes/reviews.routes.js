const express = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const { listReviews, runNow, listWpPosts, createWpPost, deleteWpPost } = require("../controllers/reviews.controller");

const router = express.Router();

router.get("/", requireAuth, listReviews);
router.post("/run-now", requireAuth, runNow);
router.get("/wp-posts", requireAuth, listWpPosts);
router.post("/wp-posts", requireAuth, createWpPost);
router.delete("/wp-posts/:id", requireAuth, deleteWpPost);

module.exports = router;
