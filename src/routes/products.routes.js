const express = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const {
  listProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getHistory,
  getStockEvents,
  checkAll,
  reportCheck,
  checkNow,
} = require("../controllers/products.controller");

const router = express.Router();

router.get("/", requireAuth, listProducts);
router.post("/", requireAuth, createProduct);
router.put("/:id", requireAuth, updateProduct);
router.delete("/:id", requireAuth, deleteProduct);
router.get("/:id/history", requireAuth, getHistory);
router.get("/:id/stock-events", requireAuth, getStockEvents);
router.post("/check-all", requireAuth, checkAll);
router.post("/:id/check-now", requireAuth, checkNow);

// Called by an external local worker script, not the dashboard — authenticated by its
// own shared secret (checked inside the controller), so no JWT here.
router.post("/:id/report-check", reportCheck);

module.exports = router;
