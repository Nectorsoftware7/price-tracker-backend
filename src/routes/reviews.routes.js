const express = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const { blockViewer } = require("../middlewares/requireRole.middleware");
const { listReviews, runNow, listWpPosts, createWpPost, deleteWpPost } = require("../controllers/reviews.controller");

const router = express.Router();

router.get("/", requireAuth, listReviews);
router.post("/run-now", requireAuth, blockViewer, runNow);
router.get("/wp-posts", requireAuth, listWpPosts);
router.post("/wp-posts", requireAuth, blockViewer, createWpPost);
router.delete("/wp-posts/:id", requireAuth, blockViewer, deleteWpPost);

module.exports = router;
