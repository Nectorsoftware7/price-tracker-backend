const express = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const { blockViewer } = require("../middlewares/requireRole.middleware");
const {
  listProducts,
  createProduct,
  bulkImportProducts,
  updateProduct,
  deleteProduct,
  getHistory,
  getAllStats,
  getDashboard,
  getStockEvents,
  getAllStockEvents,
  checkAll,
  reportCheck,
  checkNow,
} = require("../controllers/products.controller");

const router = express.Router();

router.get("/", requireAuth, listProducts);
router.post("/", requireAuth, blockViewer, createProduct);
router.post("/bulk-import", requireAuth, blockViewer, bulkImportProducts);
router.put("/:id", requireAuth, blockViewer, updateProduct);
router.delete("/:id", requireAuth, blockViewer, deleteProduct);
router.get("/stats", requireAuth, getAllStats);
router.get("/dashboard", requireAuth, getDashboard);
router.get("/stock-events", requireAuth, getAllStockEvents);
router.get("/:id/history", requireAuth, getHistory);
router.get("/:id/stock-events", requireAuth, getStockEvents);
router.post("/check-all", requireAuth, blockViewer, checkAll);
router.post("/:id/check-now", requireAuth, blockViewer, checkNow);

// Called by an external local worker script, not the dashboard — authenticated by its
// own shared secret (checked inside the controller), so no JWT here.
router.post("/:id/report-check", reportCheck);

module.exports = router;
